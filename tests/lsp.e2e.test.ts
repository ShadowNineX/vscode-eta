import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { DEFAULT_ETA_LANGUAGE_OPTIONS } from "../src/etaConfig";
import {
  ETA_LANGUAGE_SUPPORT_MANIFEST,
  loadEtaLanguageSupportManifest,
  sha256Text,
} from "../src/etaManifest";
import { positionToOffset } from "../src/position";
import { buildVirtualDocument } from "../src/virtualDocument";
import { EtaManifestBuilder } from "../src/manifestBuilder";
import { Eta } from "eta";
import type {
  CompletionItem,
  CompletionList,
  Hover,
  InitializeResult,
  Location,
  LocationLink,
  SemanticTokens,
  WorkspaceEdit,
} from "vscode-languageserver/node";

const templateSource = '<h1><%= it.user.name.toUpperCase() %></h1>\n';
const manifestTemplateSource =
  '<h2><%= it.runtimeOnly %></h2>\n<%~ include("generated-") %>\n';
const excludedTemplateSource = "<%= it.metrics.visits %>\n";

function asCompletionItems(
  result: CompletionItem[] | CompletionList | null,
): CompletionItem[] {
  if (!result) return [];
  return Array.isArray(result) ? result : result.items;
}

function definitionUri(location: Location | LocationLink): string {
  return "targetUri" in location ? location.targetUri : location.uri;
}

describe("bundled language server", () => {
  let workspace: string;
  let workspaceLink: string;
  let templateUri: string;
  let manifestTemplateUri: string;
  let excludedTemplateUri: string;
  let nestedTemplateUri: string;
  let nestedRoot: string;
  let clientTemplateUri: string;
  let runtimeRoot: string;
  let runtimeTemplateUri: string;
  let transformedTemplateUri: string;
  let startupNestedUnknownUri: string;
  const startupManifestCases: Array<{ root: string; uri: string; source: string; kind: string }> = [];
  const runtimeSource = '{{: view.runtimeCount.toFixed(2) }}\n{{~ include("runtime-") }}\n' +
    '{{: view.dictionary["chosen"].value.toFixed(2) }}\n';
  const transformedSource = "@runtimeCount";
  const clientSource = "<%= it.value %>\n<%= document.title %>\n";
  let server: ChildProcessWithoutNullStreams;
  let connection: MessageConnection;
  let stderr = "";

  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eta-lsp-e2e-"));
    workspaceLink = `${workspace}-link`;
    fs.symlinkSync(workspace, workspaceLink, process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(
      path.join(workspace, "index.ts"),
      'import { Eta } from "eta";\n' +
        "const eta = new Eta({ views: __dirname });\n" +
        'const profileData = { user: { name: "Ada" } };\n' +
        'eta.render("profile", profileData);\n' +
        'eta.render("explicit-any", {} as any);\n',
    );
    fs.writeFileSync(path.join(workspace, "profile.eta"), templateSource);
    fs.writeFileSync(path.join(workspace, "explicit-any.eta"), "<%= it.title.toUpperCase() %>");
    for (const kind of ["stale", "invalid"]) {
      const root = path.join(workspace, `startup-${kind}`);
      fs.mkdirSync(root);
      const source = "<%= it.amount.toUpperCase() %>\n";
      fs.writeFileSync(path.join(root, "card.eta"), source);
      fs.writeFileSync(path.join(root, "render.ts"), 'import { Eta } from "eta";\n' +
        'const eta = new Eta({ views: __dirname });\neta.render("card", { amount: 42 });\n');
      fs.writeFileSync(path.join(root, "loader.txt"), "original");
      new EtaManifestBuilder({ root, inputs: ["loader.txt"] })
        .addTemplate({ path: "card.eta", dataType: "{ amount: string }" }).write();
      if (kind === "stale") fs.writeFileSync(path.join(root, "loader.txt"), "changed");
      else fs.writeFileSync(path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST), "{");
      if (kind === "stale") {
        const nested = path.join(root, "nested");
        fs.mkdirSync(nested);
        fs.writeFileSync(path.join(nested, "registered.eta"), "<%= it.ready %>");
        fs.writeFileSync(path.join(nested, "unknown.eta"), "<%= it.value %>");
        new EtaManifestBuilder({ root: nested }).addTemplate({ path: "registered.eta", dataType: "{ ready: boolean }" }).write();
        startupNestedUnknownUri = pathToFileURL(path.join(nested, "unknown.eta")).toString();
      }
      startupManifestCases.push({ root, uri: pathToFileURL(path.join(root, "card.eta")).toString(), source, kind });
    }
    fs.writeFileSync(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "commonjs",
          target: "ES2020",
          strict: true,
          noEmit: true,
          lib: ["ES2020"],
          baseUrl: ".",
          paths: { "@models/*": ["models/*"] },
        },
        include: ["index.ts"],
      }),
    );
    nestedRoot = path.join(workspace, "app");
    fs.mkdirSync(nestedRoot);
    for (const [directory, valueType] of [
      ["strings", "string"],
      ["numbers", "number"],
    ]) {
      fs.mkdirSync(path.join(nestedRoot, directory));
      fs.writeFileSync(
        path.join(nestedRoot, directory, "data.ts"),
        `export interface Data { value: ${valueType} }\n`,
      );
    }
    fs.writeFileSync(
      path.join(nestedRoot, "settings.json"),
      JSON.stringify({
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          lib: ["ES2020", "DOM"],
          baseUrl: ".",
          paths: { "@data": ["strings/data.ts"] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(nestedRoot, "tsconfig.json"),
      JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
    );
    fs.writeFileSync(
      path.join(nestedRoot, "tsconfig.app.json"),
      JSON.stringify({ extends: "./settings.json", include: ["*.ts"] }),
    );
    fs.writeFileSync(
      path.join(nestedRoot, "render.ts"),
      'import { Eta } from "eta";\n' +
        'import type { Data } from "@data";\n' +
        "declare const data: Data;\n" +
        "const eta = new Eta({ views: __dirname });\n" +
        'eta.render("card", data);\n',
    );
    const nestedSource = "<%= it.value %>\n<%= document.title %>\n";
    fs.writeFileSync(path.join(nestedRoot, "card.eta"), nestedSource);
    nestedTemplateUri = pathToFileURL(
      path.join(nestedRoot, "card.eta"),
    ).toString();
    const sharedRoot = path.join(workspace, "shared");
    fs.mkdirSync(sharedRoot);
    for (const name of ["client", "server"]) fs.mkdirSync(path.join(sharedRoot, name));
    fs.writeFileSync(path.join(sharedRoot, "tsconfig.json"), JSON.stringify({
      files: [], references: [{ path: "./tsconfig.a-server.json" }, { path: "./tsconfig.z-client.json" }],
    }));
    for (const [name, libs] of [["a-server", ["ES2020"]], ["z-client", ["ES2020", "DOM"]]] as const) {
      fs.writeFileSync(path.join(sharedRoot, `tsconfig.${name}.json`), JSON.stringify({
        compilerOptions: { target: "ES2020", module: "esnext", moduleResolution: "bundler", strict: true, lib: libs },
        include: [`${name.endsWith("client") ? "client" : "server"}/*.ts`],
      }));
    }
    fs.writeFileSync(path.join(sharedRoot, "client", "render.ts"),
      'import { Eta } from "eta";\nimport path from "node:path";\n' +
      'const eta = new Eta({ views: path.join(__dirname, "..") });\n' +
      'eta.render("client-card", { value: "client" });\n');
    fs.writeFileSync(path.join(sharedRoot, "server", "index.ts"),
      "export const serverOnly = true;\ndeclare global { interface Array<T> { serverOnly(): string } }\n");
    fs.writeFileSync(path.join(sharedRoot, "client-card.eta"), clientSource);
    clientTemplateUri = pathToFileURL(path.join(sharedRoot, "client-card.eta")).toString();
    const excludedDir = path.join(workspace, "scenarios");
    fs.mkdirSync(excludedDir);
    const modelsDir = path.join(workspace, "models");
    fs.mkdirSync(modelsDir);
    fs.writeFileSync(
      path.join(modelsDir, "page.ts"),
      "export interface LayoutPage {\n" +
        "  metrics: { visits: number };\n" +
        "}\n",
    );
    fs.writeFileSync(
      path.join(excludedDir, "render.ts"),
      'import { Eta } from "eta";\n' +
        'import type { LayoutPage } from "@models/page";\n' +
        "const eta = new Eta({ views: __dirname });\n" +
        "const page: LayoutPage = { metrics: { visits: 8420 } };\n" +
        'eta.render("layout-page", page);\n',
    );
    fs.writeFileSync(
      path.join(excludedDir, "layout-page.eta"),
      excludedTemplateSource,
    );
    const runtimeDataSource = 'export const runtimeOnly = "generated";\n';
    const runtimeDataPath = path.join(workspace, "runtime-data.ts");
    const manifestTemplatePath = path.join(workspace, "generated.eta");
    fs.writeFileSync(runtimeDataPath, runtimeDataSource);
    fs.writeFileSync(manifestTemplatePath, manifestTemplateSource);
    const virtual = buildVirtualDocument(
      manifestTemplateSource,
      "{ runtimeOnly: string }",
      DEFAULT_ETA_LANGUAGE_OPTIONS,
    );
    const bodyStart = positionToOffset(
      virtual.content,
      virtual.preambleLineCount,
      0,
    );
    const referenceStart = manifestTemplateSource.indexOf("runtimeOnly");
    const definitionStart = runtimeDataSource.indexOf("runtimeOnly");
    fs.writeFileSync(
      path.join(workspace, ETA_LANGUAGE_SUPPORT_MANIFEST),
      JSON.stringify({
        $schema:
          "https://raw.githubusercontent.com/ShadowNineX/vscode-eta/main/schemas/eta-language-support.schema.json",
        version: 1,
        inputs: [
          {
            path: "runtime-data.ts",
            sha256: sha256Text(runtimeDataSource),
          },
        ],
        templates: [
          {
            path: "generated.eta",
            sha256: sha256Text(manifestTemplateSource),
            options: DEFAULT_ETA_LANGUAGE_OPTIONS,
            dataType: "{ runtimeOnly: string }",
            dataDefinitions: [
              {
                dataPath: ["runtimeOnly"],
                location: {
                  path: "runtime-data.ts",
                  start: definitionStart,
                  length: "runtimeOnly".length,
                },
              },
            ],
            resolution: { views: null, defaultExtension: ".eta" },
            relationships: [],
            diagnostics: [],
            virtualDocument: {
              content: virtual.content,
              mappings: [
                {
                  sourceStart: 0,
                  sourceLength: manifestTemplateSource.length,
                  virtualStart: bodyStart,
                  virtualLength: manifestTemplateSource.length,
                },
              ],
            },
          },
        ],
        templateNames: [
          {
            name: "generated-profile",
            template: "generated.eta",
            definition: {
              path: "runtime-data.ts",
              start: definitionStart,
              length: "runtimeOnly".length,
            },
          },
        ],
        symbols: [
          {
            id: "runtime:only",
            occurrences: [
              {
                path: "runtime-data.ts",
                start: definitionStart,
                length: "runtimeOnly".length,
                role: "definition",
              },
              {
                path: "generated.eta",
                start: referenceStart,
                length: "runtimeOnly".length,
                role: "reference",
              },
            ],
          },
        ],
      }),
    );

    runtimeRoot = path.join(workspace, "runtime-app");
    fs.mkdirSync(runtimeRoot);
    fs.writeFileSync(path.join(runtimeRoot, "model.ts"), "export interface RuntimeView { runtimeCount: number; dictionary: Dictionary }\n" +
      "export interface Dictionary { readonly [key: string]: { value: number } }\n");
    fs.writeFileSync(path.join(runtimeRoot, "loader.txt"), "runtime-card\n");
    fs.writeFileSync(path.join(runtimeRoot, "eta.manifest.config.mjs"),
      'import fs from "node:fs"; fs.writeFileSync(new URL("executed.txt", import.meta.url), "executed");\n');
    const runtimeEta = new Eta({ tags: ["{{", "}}"], parse: { interpolate: ":", exec: "", raw: "~" }, varName: "view" });
    const builder = new EtaManifestBuilder({ root: runtimeRoot, inputs: ["loader.txt", "eta.manifest.config.mjs"] });
    builder.addTemplate({
      path: ".eta-generated/card.eta", source: runtimeSource,
      dataType: { file: "model.ts", export: "RuntimeView" },
      eta: runtimeEta, names: [fs.readFileSync(path.join(runtimeRoot, "loader.txt"), "utf8").trim()],
    });
    const transformedVirtual = "function __etaTemplate(view: { runtimeCount: number }) { view.runtimeCount; }\nexport {};";
    builder.addTemplate({
      path: ".eta-generated/transformed.eta", source: transformedSource,
      dataType: { file: "model.ts", export: "RuntimeView" },
      transformed: true,
      eta: runtimeEta,
      virtualDocument: {
        content: transformedVirtual,
        mappings: [{ sourceStart: 1, sourceLength: "runtimeCount".length,
          virtualStart: transformedVirtual.lastIndexOf("runtimeCount"), virtualLength: "runtimeCount".length }],
      },
    }).write();
    runtimeTemplateUri = pathToFileURL(path.join(runtimeRoot, ".eta-generated", "card.eta")).toString();
    transformedTemplateUri = pathToFileURL(path.join(runtimeRoot, ".eta-generated", "transformed.eta")).toString();
    const parentManifestPath = path.join(workspace, ETA_LANGUAGE_SUPPORT_MANIFEST);
    const parentManifest = JSON.parse(fs.readFileSync(parentManifestPath, "utf8"));
    const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, ETA_LANGUAGE_SUPPORT_MANIFEST), "utf8"));
    const runtimeCard = runtimeManifest.templates.find((template: { path: string }) => template.path.endsWith("/card.eta"));
    parentManifest.templates.push({ ...runtimeCard, path: "runtime-app/.eta-generated/card.eta" });
    fs.writeFileSync(parentManifestPath, JSON.stringify(parentManifest));

    templateUri = pathToFileURL(path.join(workspace, "profile.eta")).toString();
    manifestTemplateUri = pathToFileURL(
      path.join(workspace, "generated.eta"),
    ).toString();
    excludedTemplateUri = pathToFileURL(
      path.join(workspace, "scenarios", "layout-page.eta"),
    ).toString();
    server = spawn(process.execPath, [path.resolve("out", "server.js"), "--stdio"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    server.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    connection = createMessageConnection(
      new StreamMessageReader(server.stdout),
      new StreamMessageWriter(server.stdin),
    );
    connection.listen();

    const rootUri = pathToFileURL(workspaceLink).toString();
    const initialized = await connection.sendRequest<InitializeResult>(
      "initialize",
      {
        processId: null,
        rootUri,
        capabilities: { workspace: { workspaceFolders: true } },
        initializationOptions: {},
      },
    );
    expect(initialized.capabilities.definitionProvider).toBe(true);
    expect(initialized.capabilities.completionProvider).toBeTruthy();
    await connection.sendNotification("initialized", {});
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: templateUri,
        languageId: "eta",
        version: 1,
        text: templateSource,
      },
    });
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: excludedTemplateUri,
        languageId: "eta",
        version: 1,
        text: excludedTemplateSource,
      },
    });
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: manifestTemplateUri,
        languageId: "eta",
        version: 1,
        text: manifestTemplateSource,
      },
    });
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: nestedTemplateUri,
        languageId: "eta",
        version: 1,
        text: nestedSource,
      },
    });
  }, 30_000);

  afterAll(async () => {
    const closed = server?.exitCode === null ? once(server, "close") : undefined;
    const forceStop = setTimeout(() => server?.kill(), 5_000);
    try {
      if (connection && server?.exitCode === null) {
        await connection.sendRequest("shutdown");
        // Flush the exit notification before closing the transport. Killing the
        // child while this write is pending causes an unhandled EPIPE on Windows.
        await connection.sendNotification("exit");
      }
      if (closed) await closed;
    } finally {
      clearTimeout(forceStop);
      connection?.dispose();
      if (server?.exitCode === null) {
        server.kill();
        if (closed) await closed;
      }
      if (workspaceLink && fs.existsSync(workspaceLink)) fs.unlinkSync(workspaceLink);
      if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("resolves template providers through a linked workspace URI", async () => {
    const uri = pathToFileURL(path.join(workspaceLink, "profile.eta")).toString();
    try {
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "eta", version: 1, text: templateSource },
      });
      const hover = await connection.sendRequest<Hover | null>("textDocument/hover", {
        textDocument: { uri }, position: { line: 0, character: templateSource.indexOf("name") + 1 },
      });
      expect(JSON.stringify(hover?.contents)).toMatch(/name.*string/);
    } finally {
      await connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
    }
  });

  it("serves completion, hover, and source definition over stdio", async () => {
    const propertyStart = templateSource.indexOf("name");
    const completion = await connection.sendRequest<
      CompletionItem[] | CompletionList | null
    >("textDocument/completion", {
      textDocument: { uri: templateUri },
      position: { line: 0, character: propertyStart },
    });
    expect(asCompletionItems(completion).map((item) => item.label)).toContain(
      "name",
    );

    const hover = await connection.sendRequest<Hover | null>(
      "textDocument/hover",
      {
        textDocument: { uri: templateUri },
        position: { line: 0, character: propertyStart + 1 },
      },
    );
    expect(hover).not.toBeNull();
    expect(JSON.stringify(hover?.contents)).toMatch(/name.*string/);

    const definitions = await connection.sendRequest<
      Array<Location | LocationLink> | null
    >("textDocument/definition", {
      textDocument: { uri: templateUri },
      position: { line: 0, character: propertyStart + 1 },
    });
    expect(definitions).toHaveLength(1);
    expect(path.basename(new URL(definitionUri(definitions![0])).pathname)).toBe(
      "index.ts",
    );
    expect(stderr).toBe("");
  });
  it("infers hover from render calls excluded by tsconfig", async () => {
    const itStart = excludedTemplateSource.indexOf("it");
    const itHover = await connection.sendRequest<Hover | null>(
      "textDocument/hover",
      {
        textDocument: { uri: excludedTemplateUri },
        position: { line: 0, character: itStart + 1 },
      },
    );
    expect(JSON.stringify(itHover?.contents)).not.toContain(
      "Record<string, any>",
    );

    const propertyStart = excludedTemplateSource.indexOf("visits");
    const propertyHover = await connection.sendRequest<Hover | null>(
      "textDocument/hover",
      {
        textDocument: { uri: excludedTemplateUri },
        position: { line: 0, character: propertyStart + 1 },
      },
    );
    expect(JSON.stringify(propertyHover?.contents)).toMatch(
      /visits.*number/,
    );
  });
  it("refreshes nested projects when extended and referenced configs change", async () => {
    const hover = () => connection.sendRequest<Hover | null>(
      "textDocument/hover",
      {
        textDocument: { uri: nestedTemplateUri },
        position: { line: 0, character: 8 },
      },
    );
    expect(JSON.stringify((await hover())?.contents)).toMatch(/value.*string/);
    const diagnostics: Array<{ source?: string; message: string }> = [];
    const subscription = connection.onNotification(
      "textDocument/publishDiagnostics",
      (params) => {
        if (params.uri === nestedTemplateUri) diagnostics.push(...params.diagnostics);
      },
    );
    try {
      const settingsPath = path.join(nestedRoot, "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      settings.compilerOptions.paths["@data"] = ["numbers/data.ts"];
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      await connection.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(settingsPath).toString(), type: 2 }],
      });
      expect(JSON.stringify((await hover())?.contents)).toMatch(/value.*number/);
      expect(diagnostics.filter((item) => item.source === "TypeScript")).toEqual([]);

      const configPath = path.join(nestedRoot, "tsconfig.app.json");
      fs.writeFileSync(configPath, JSON.stringify({
        extends: "./settings.json",
        include: ["*.ts"],
        compilerOptions: { paths: { "@data": ["strings/data.ts"] } },
      }));
      await connection.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(configPath).toString(), type: 2 }],
      });
      expect(JSON.stringify((await hover())?.contents)).toMatch(/value.*string/);
    } finally {
      subscription.dispose();
    }
  });
  it("reanalyzes created and deleted render sources without restarting", async () => {
    const sourcePath = path.join(nestedRoot, "created.ts");
    const templatePath = path.join(nestedRoot, "created.eta");
    fs.writeFileSync(
      sourcePath,
      'import { Eta } from "eta";\n' +
        "const eta = new Eta({ views: __dirname });\n" +
        'eta.render("created", { fresh: ["typed"] });\n',
    );
    const source = "<%= it.fresh %>\n";
    fs.writeFileSync(templatePath, source);
    const uri = pathToFileURL(templatePath).toString();
    await connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [sourcePath, templatePath].map((file) => ({
        uri: pathToFileURL(file).toString(), type: 1,
      })),
    });
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "eta", version: 1, text: source },
    });
    const hover = () => connection.sendRequest<Hover | null>(
      "textDocument/hover",
      {
        textDocument: { uri },
        position: { line: 0, character: 4 },
      },
    );
    expect(JSON.stringify((await hover())?.contents)).toMatch(
      /fresh: (?:string\[\]|Array<string>)/,
    );
    fs.unlinkSync(sourcePath);
    await connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(sourcePath).toString(), type: 3 }],
    });
    expect(JSON.stringify((await hover())?.contents)).not.toContain("fresh:");
  });
  it("uses the render source's named project for template language features", async () => {
    const published: Array<{ source?: string; message: string }> = [];
    const subscription = connection.onNotification("textDocument/publishDiagnostics", (params) => {
      if (params.uri === clientTemplateUri) published.push(...params.diagnostics);
    });
    try {
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri: clientTemplateUri, languageId: "eta", version: 1, text: clientSource },
      });
      const hover = await connection.sendRequest<Hover | null>("textDocument/hover", {
        textDocument: { uri: clientTemplateUri }, position: { line: 1, character: 7 },
      });
      expect(JSON.stringify(hover?.contents)).toContain("Document");
      expect(published.filter((item) => item.source === "TypeScript")).toEqual([]);
      await connection.sendNotification("textDocument/didChange", {
        textDocument: { uri: clientTemplateUri, version: 2 },
        contentChanges: [{ text: clientSource + "<%= [].serverOnly() %>\n" }],
      });
      await connection.sendRequest("textDocument/hover", {
        textDocument: { uri: clientTemplateUri }, position: { line: 1, character: 7 },
      });
      expect(published.some((item) => item.source === "TypeScript" && item.message.includes("serverOnly"))).toBe(true);
    } finally {
      subscription.dispose();
    }
  });
  it("serves authoritative manifest data and mapped navigation over stdio", async () => {
    const propertyStart = manifestTemplateSource.indexOf("runtimeOnly");
    const completion = await connection.sendRequest<
      CompletionItem[] | CompletionList | null
    >("textDocument/completion", {
      textDocument: { uri: manifestTemplateUri },
      position: { line: 0, character: propertyStart },
    });
    expect(asCompletionItems(completion).map((item) => item.label)).toContain(
      "runtimeOnly",
    );

    const hover = await connection.sendRequest<Hover | null>(
      "textDocument/hover",
      {
        textDocument: { uri: manifestTemplateUri },
        position: { line: 0, character: propertyStart + 1 },
      },
    );
    expect(JSON.stringify(hover?.contents)).toMatch(/runtimeOnly.*string/);

    const definitions = await connection.sendRequest<
      Array<Location | LocationLink> | null
    >("textDocument/definition", {
      textDocument: { uri: manifestTemplateUri },
      position: { line: 0, character: propertyStart + 1 },
    });
    expect(definitions).toHaveLength(1);
    expect(path.basename(new URL(definitionUri(definitions![0])).pathname)).toBe(
      "runtime-data.ts",
    );

    const references = await connection.sendRequest<Location[]>(
      "textDocument/references",
      {
        textDocument: { uri: manifestTemplateUri },
        position: { line: 0, character: propertyStart + 1 },
        context: { includeDeclaration: true },
      },
    );
    expect(references).toHaveLength(2);

    const rename = await connection.sendRequest<WorkspaceEdit | null>(
      "textDocument/rename",
      {
        textDocument: { uri: manifestTemplateUri },
        position: { line: 0, character: propertyStart + 1 },
        newName: "renamedRuntime",
      },
    );
    expect(Object.keys(rename?.changes ?? {})).toEqual(
      expect.arrayContaining([
        manifestTemplateUri,
        pathToFileURL(path.join(workspace, "runtime-data.ts")).toString(),
      ]),
    );

    const pathCompletion = await connection.sendRequest<
      CompletionItem[] | CompletionList | null
    >("textDocument/completion", {
      textDocument: { uri: manifestTemplateUri },
      position: {
        line: 1,
        character: '<%~ include("generated-'.length,
      },
    });
    expect(
      asCompletionItems(pathCompletion).map((item) => item.label),
    ).toContain("generated-profile");

    const semanticTokens = await connection.sendRequest<SemanticTokens>(
      "textDocument/semanticTokens/full",
      { textDocument: { uri: manifestTemplateUri } },
    );
    expect(semanticTokens.data.length).toBeGreaterThan(0);
    expect(stderr).toBe("");
  });
  it("supports untitled Eta documents while a workspace project is active", async () => {
    const uri = "untitled:eta-scratch.eta";
    const source = '<%= "test".toUpperCase() %>\n';
    try {
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "eta", version: 1, text: source },
      });
      const hover = await connection.sendRequest<Hover | null>("textDocument/hover", {
        textDocument: { uri }, position: { line: 0, character: source.indexOf("toUpperCase") + 1 },
      });
      expect(JSON.stringify(hover?.contents)).toMatch(/toUpperCase.*string/);
    } finally {
      await connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
    }
  });

  it("reports unresolved data honestly and preserves application-declared any", async () => {
    const published = new Map<string, Array<{ source: string; severity: number; message: string }>>();
    const subscription = connection.onNotification("textDocument/publishDiagnostics", (params) => {
      published.set(params.uri, params.diagnostics);
    });
    const cases = [
      { name: "untyped", source: "<%= it.title.toUpperCase() %>", missing: true },
      { name: "explicit-any", source: "<%= it.title.toUpperCase() %>", missing: false },
      { name: "plain-html", source: "<span>it.title</span>", missing: false },
    ];
    try {
      for (const test of cases) {
        const uri = pathToFileURL(path.join(workspace, `${test.name}.eta`)).toString();
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: { uri, languageId: "eta", version: 1, text: test.source },
        });
        const hover = await connection.sendRequest<Hover | null>("textDocument/hover", {
          textDocument: { uri }, position: { line: 0, character: 5 },
        });
        const inferenceMessages = (published.get(uri) ?? []).filter((item) => item.message.includes("no render data could be inferred"));
        expect(inferenceMessages).toHaveLength(test.missing ? 1 : 0);
        if (test.missing) {
          expect(JSON.stringify(hover?.contents)).toContain("Record<string, unknown>");
          expect(inferenceMessages[0]).toMatchObject({ severity: 3, source: "Eta" });
          expect(inferenceMessages[0].message).toContain(".eta-language-support.json");
        }
        await connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
      }
    } finally {
      subscription.dispose();
    }
  });

  it("uses nested builder manifests for runtime aliases, generated templates, and transformations", async () => {
    for (const [uri, source, propertyStart] of [
      [runtimeTemplateUri, runtimeSource, runtimeSource.indexOf("runtimeCount")],
      [transformedTemplateUri, transformedSource, 1],
    ] as const) {
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "eta", version: 1, text: source },
      });
      const hover = await connection.sendRequest<Hover | null>("textDocument/hover", {
        textDocument: { uri }, position: { line: 0, character: propertyStart + 1 },
      });
      expect(JSON.stringify(hover?.contents)).toMatch(/runtimeCount.*number/);
    }
    const paths = await connection.sendRequest<CompletionItem[] | CompletionList | null>("textDocument/completion", {
      textDocument: { uri: runtimeTemplateUri }, position: { line: 1, character: '{{~ include("runtime-'.length },
    });
    expect(asCompletionItems(paths).map((item) => item.label)).toContain("runtime-card");
    const dictionaryHover = await connection.sendRequest<Hover | null>("textDocument/hover", {
      textDocument: { uri: runtimeTemplateUri },
      position: { line: 2, character: '{{: view.dictionary["chosen"].'.length + 1 },
    });
    expect(JSON.stringify(dictionaryHover?.contents)).toMatch(/value.*number/);
    expect(fs.existsSync(path.join(runtimeRoot, "executed.txt"))).toBe(false);
  });

  it("retains fallback TypeScript diagnostics when manifests are unavailable at startup", async () => {
    const published = new Map<string, Array<{ source: string; message: string }>>();
    const subscription = connection.onNotification("textDocument/publishDiagnostics", (params) => {
      published.set(params.uri, params.diagnostics);
    });
    try {
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri: startupNestedUnknownUri, languageId: "eta", version: 1, text: "<%= it.value %>" },
      });
      await connection.sendRequest("textDocument/hover", {
        textDocument: { uri: startupNestedUnknownUri }, position: { line: 0, character: 5 },
      });
      const nestedDiagnostics = published.get(startupNestedUnknownUri) ?? [];
      expect(nestedDiagnostics.some((item) => item.message.includes("Manifest unavailable"))).toBe(false);
      expect(nestedDiagnostics.some((item) => item.message.includes("no render data could be inferred"))).toBe(true);
      await connection.sendNotification("textDocument/didClose", { textDocument: { uri: startupNestedUnknownUri } });
      for (const { root, uri, source, kind } of startupManifestCases) {
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: { uri, languageId: "eta", version: 1, text: source },
        });
        for (let request = 0; request < 2; request++) {
          await connection.sendRequest("textDocument/hover", {
            textDocument: { uri }, position: { line: 0, character: source.indexOf("amount") + 1 },
          });
        }
        const diagnostics = published.get(uri) ?? [];
        expect(diagnostics.some((item) => item.source === "Eta" && item.message.includes("Manifest unavailable"))).toBe(true);
        expect(diagnostics.some((item) => item.source === "TypeScript" && item.message.includes("toUpperCase"))).toBe(true);
        if (kind === "stale") {
          // Even an initially stale, watcher-excluded input can recover without
          // repeatedly invalidating the fallback virtual document on each read.
          fs.writeFileSync(path.join(root, "loader.txt"), "original");
          const hover = await connection.sendRequest<Hover | null>("textDocument/hover", {
            textDocument: { uri }, position: { line: 0, character: source.indexOf("amount") + 1 },
          });
          expect(JSON.stringify(hover?.contents)).toMatch(/amount.*string/);
          await connection.sendNotification("textDocument/didChange", {
            textDocument: { uri, version: 2 }, contentChanges: [{ text: source }],
          });
          await connection.sendRequest("textDocument/hover", {
            textDocument: { uri }, position: { line: 0, character: 1 },
          });
          expect(published.get(uri)).toEqual([]);
        }
        await connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
      }
    } finally {
      subscription.dispose();
    }
  });

  it("invalidates excluded runtime inputs even without a watcher notification", async () => {
    const diagnostics: Array<{ source: string; message: string }> = [];
    const subscription = connection.onNotification("textDocument/publishDiagnostics", (params) => {
      if (params.uri === runtimeTemplateUri) diagnostics.push(...params.diagnostics);
    });
    try {
      const input = path.join(runtimeRoot, "loader.txt");
      fs.writeFileSync(input, "changed-runtime-card\n");
      expect(loadEtaLanguageSupportManifest(workspace).status).toBe("loaded");
      const hover = await connection.sendRequest<Hover | null>("textDocument/hover", {
        textDocument: { uri: runtimeTemplateUri }, position: { line: 0, character: runtimeSource.indexOf("runtimeCount") + 1 },
      });
      expect(JSON.stringify(hover?.contents) ?? "").not.toMatch(/runtimeCount.*number/);
      await connection.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(input).toString(), type: 2 }],
      });
      await connection.sendNotification("textDocument/didChange", {
        textDocument: { uri: runtimeTemplateUri, version: 2 }, contentChanges: [{ text: runtimeSource }],
      });
      await connection.sendRequest("textDocument/hover", {
        textDocument: { uri: runtimeTemplateUri }, position: { line: 0, character: 1 },
      });
      expect(diagnostics.some((item) => item.source === "Eta" && item.message.includes("Manifest unavailable"))).toBe(true);
      expect(fs.existsSync(path.join(runtimeRoot, "executed.txt"))).toBe(false);
      fs.writeFileSync(input, "runtime-card\n");
      const recovered = await connection.sendRequest<Hover | null>("textDocument/hover", {
        textDocument: { uri: runtimeTemplateUri }, position: { line: 0, character: runtimeSource.indexOf("runtimeCount") + 1 },
      });
      expect(JSON.stringify(recovered?.contents)).toMatch(/runtimeCount.*number/);

      const related = path.join(runtimeRoot, ".eta-generated", "transformed.eta");
      fs.writeFileSync(related, "changed related template");
      const staleRelated = await connection.sendRequest<Hover | null>("textDocument/hover", {
        textDocument: { uri: runtimeTemplateUri }, position: { line: 0, character: runtimeSource.indexOf("runtimeCount") + 1 },
      });
      expect(JSON.stringify(staleRelated?.contents) ?? "").not.toMatch(/runtimeCount.*number/);
      fs.writeFileSync(related, transformedSource);
      const restoredRelated = await connection.sendRequest<Hover | null>("textDocument/hover", {
        textDocument: { uri: runtimeTemplateUri }, position: { line: 0, character: runtimeSource.indexOf("runtimeCount") + 1 },
      });
      expect(JSON.stringify(restoredRelated?.contents)).toMatch(/runtimeCount.*number/);
    } finally {
      subscription.dispose();
    }
  });

});
