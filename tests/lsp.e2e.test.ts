import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  sha256Text,
} from "../src/etaManifest";
import { positionToOffset } from "../src/position";
import { buildVirtualDocument } from "../src/virtualDocument";
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
  let templateUri: string;
  let manifestTemplateUri: string;
  let excludedTemplateUri: string;
  let server: ChildProcessWithoutNullStreams;
  let connection: MessageConnection;
  let stderr = "";

  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eta-lsp-e2e-"));
    fs.writeFileSync(
      path.join(workspace, "index.ts"),
      'import { Eta } from "eta";\n' +
        "const eta = new Eta({ views: __dirname });\n" +
        'const profileData = { user: { name: "Ada" } };\n' +
        'eta.render("profile", profileData);\n',
    );
    fs.writeFileSync(path.join(workspace, "profile.eta"), templateSource);
    fs.writeFileSync(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "commonjs",
          target: "ES2020",
          strict: true,
          noEmit: true,
          baseUrl: ".",
          paths: { "@models/*": ["models/*"] },
        },
        include: ["index.ts"],
      }),
    );
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

    const rootUri = pathToFileURL(workspace).toString();
    const initialized = await connection.sendRequest<InitializeResult>(
      "initialize",
      {
        processId: null,
        rootUri,
        capabilities: { workspace: { workspaceFolders: true } },
        workspaceFolders: [{ uri: rootUri, name: "eta-lsp-e2e" }],
        initializationOptions: {},
      },
    );
    expect(initialized.capabilities.definitionProvider).toBe(true);
    expect(initialized.capabilities.completionProvider).toBeTruthy();
    connection.sendNotification("initialized", {});
    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: templateUri,
        languageId: "eta",
        version: 1,
        text: templateSource,
      },
    });
    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: excludedTemplateUri,
        languageId: "eta",
        version: 1,
        text: excludedTemplateSource,
      },
    });
    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: manifestTemplateUri,
        languageId: "eta",
        version: 1,
        text: manifestTemplateSource,
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (connection) {
      try {
        await connection.sendRequest("shutdown");
        connection.sendNotification("exit");
      } finally {
        connection.dispose();
      }
    }
    if (server && server.exitCode === null) server.kill();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
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

});
