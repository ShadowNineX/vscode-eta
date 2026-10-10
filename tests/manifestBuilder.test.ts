import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Eta } from "eta";
import * as ts from "typescript";
import { EtaManifestBuilder } from "../src/manifestBuilder";
import { ETA_LANGUAGE_SUPPORT_MANIFEST, loadEtaLanguageSupportManifest, MAX_MANIFEST_BYTES, MAX_MANIFEST_FILES } from "../src/etaManifest";

const roots: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eta-builder-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "views"));
  fs.writeFileSync(path.join(root, "views", "card.eta"), "<%= it.title %>");
  fs.writeFileSync(path.join(root, "model.ts"), "export interface Card { title: string; tags: string[] }\n");
  fs.writeFileSync(path.join(root, "aliases.ts"), "export { Card as CardAlias } from './model';\n");
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{ \"compilerOptions\": { \"strict\": true } }");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("EtaManifestBuilder", () => {
  it("writes a deterministic validated manifest from physical templates and exported model types", () => {
    const root = workspace();
    const builder = new EtaManifestBuilder({ root, inputs: ["tsconfig.json"] });
    const modelSource = fs.readFileSync(path.join(root, "model.ts"), "utf8");
    builder.addTemplate({
      path: "views/card.eta",
      dataType: { file: "model.ts", export: "Card" },
      names: [{ name: "card", definition: { path: "model.ts", start: modelSource.indexOf("Card"), length: 4 } }],
      eta: { customTags: { markdown: () => "" }, customTagTypes: { markdown: "text" } },
    });
    const first = JSON.stringify(builder.build());
    const output = builder.write();
    const second = fs.readFileSync(output, "utf8");
    expect(JSON.parse(second)).toEqual(JSON.parse(first));
    const result = loadEtaLanguageSupportManifest(root);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect([...result.manifest.templateNames]).toHaveLength(1);
      expect(result.manifest.templateNames.get("card")?.definition?.fileName).toBe(path.join(root, "model.ts"));
      expect(result.manifest.inputs.size).toBeGreaterThanOrEqual(2);
      const template = result.manifest.templates.values().next().value;
      expect(template).toBeDefined();
      expect(template?.dataType).toContain("title: string");
      expect(template?.options.customTags).toEqual(["markdown"]);
    }
  });

  it("expands exported dictionary models into semantically valid virtual code", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "model.ts"), "export interface Dictionary { readonly [key: string]: { value: number } }\n");
    fs.writeFileSync(path.join(root, "views", "card.eta"), '<%= it["chosen"].value.toFixed(2) %>');
    new EtaManifestBuilder({ root }).addTemplate({
      path: "views/card.eta", dataType: { file: "model.ts", export: "Dictionary" },
    }).write();
    const result = loadEtaLanguageSupportManifest(root);
    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") throw new Error(result.messages.join("\n"));
    const template = [...result.manifest.templates.values()][0];
    expect(template.dataType).not.toContain("Dictionary");
    const fileName = path.join(root, "virtual.ts");
    const options = { strict: true, target: ts.ScriptTarget.ES2020, types: [] };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, version, ...args) => name === fileName
      ? ts.createSourceFile(name, template.virtualDocument.content, version, true)
      : getSourceFile(name, version, ...args);
    const program = ts.createProgram([fileName], options, host);
    expect(program.getSemanticDiagnostics(program.getSourceFile(fileName))).toEqual([]);
  });

  it("materializes explicit generated templates and preserves empty template mappings", () => {
    const root = workspace();
    const builder = new EtaManifestBuilder({ root });
    builder.addTemplate({
      path: ".eta-generated/empty.eta",
      source: "",
      dataType: "{ value: number }",
      names: ["generated-empty"],
    }).write();
    expect(fs.readFileSync(path.join(root, ".eta-generated", "empty.eta"), "utf8")).toBe("");
    expect(loadEtaLanguageSupportManifest(root).status).toBe("loaded");
  });

  it("requires mappings for transformed templates and keeps explicit plugin mappings", () => {
    const root = workspace();
    const builder = new EtaManifestBuilder({ root });
    expect(() => builder.addTemplate({ path: "views/card.eta", dataType: "{}", transformed: true })).toThrow("explicit virtualDocument");
    expect(() => builder.addTemplate({ path: "views/card.eta", dataType: "{}", eta: { plugins: [{}] } })).toThrow("explicit virtualDocument");
    builder.addTemplate({
      path: "views/card.eta",
      dataType: "{}",
      transformed: true,
      virtualDocument: {
        content: "const x = it.title;",
        mappings: [{ sourceStart: 4, sourceLength: 8, virtualStart: 13, virtualLength: 5 }],
      },
      symbols: [{ id: "card-title", occurrences: [{ path: "views/card.eta", start: 7, length: 5, role: "reference" }] }],
    }).write();
    const result = loadEtaLanguageSupportManifest(root);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") expect(result.manifest.symbols[0].id).toBe("card-title");
  });

  it("leaves a valid previous manifest in place when a later build is invalid", () => {
    const root = workspace();
    const initial = new EtaManifestBuilder({ root });
    initial.addTemplate({ path: "views/card.eta", dataType: "{}" }).write();
    const previous = fs.readFileSync(path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST), "utf8");
    const invalid = new EtaManifestBuilder({ root });
    invalid.addTemplate({ path: "views/card.eta", dataType: "{}", defaultExtension: "eta" });
    expect(() => invalid.write()).toThrow();
    expect(fs.readFileSync(path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST), "utf8")).toBe(previous);
  });

  it("marks a manifest stale when an automatically tracked model input changes", () => {
    const root = workspace();
    const builder = new EtaManifestBuilder({ root });
    builder.addTemplate({
      path: "views/card.eta",
      dataType: { file: "model.ts", export: "Card" },
      names: ["card", "cards/default"],
    }).write();
    fs.writeFileSync(path.join(root, "model.ts"), "export interface Card { changed: boolean }\n");
    expect(loadEtaLanguageSupportManifest(root)).toMatchObject({ status: "stale" });
  });

  it("resolves re-exported model aliases and does not replace unrelated generated files", () => {
    const root = workspace();
    const generated = path.join(root, ".eta-generated", "owned-by-user.eta");
    fs.mkdirSync(path.dirname(generated));
    fs.writeFileSync(generated, "user content");
    const builder = new EtaManifestBuilder({ root });
    expect(() => builder.addTemplate({ path: ".eta-generated/owned-by-user.eta", source: "generated", dataType: "{}" })).toThrow("overwriteGenerated");
    builder.addTemplate({
      path: "views/card.eta",
      dataType: { file: "aliases.ts", export: "CardAlias" },
    }).write();
    const result = loadEtaLanguageSupportManifest(root);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") expect(result.manifest.templates.values().next().value?.dataType).toContain("tags: Array<string>");
  });

  it("tracks in-root declaration dependencies and tsconfig bases, then rejects external model paths", () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, "configs"));
    fs.writeFileSync(path.join(root, "configs", "base.json"), "{ \"compilerOptions\": { \"strict\": true } }");
    fs.writeFileSync(path.join(root, "configs", "extra.json"), "{ \"compilerOptions\": { \"noUncheckedIndexedAccess\": true } }");
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{ \"extends\": [\"./configs/base.json\", \"./configs/extra.json\"], \"compilerOptions\": { \"moduleResolution\": \"node\", \"ignoreDeprecations\": \"6.0\" } }");
    fs.mkdirSync(path.join(root, "node_modules", "local-model"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "local-model", "index.d.ts"), "export interface LocalModel { enabled: boolean }\n");
    fs.writeFileSync(path.join(root, "model.ts"), "import type { LocalModel } from 'local-model'; export interface Card extends LocalModel { title: string }\n");
    const builder = new EtaManifestBuilder({ root });
    builder.addTemplate({ path: "views/card.eta", dataType: { file: "model.ts", export: "Card" } }).write();
    const loaded = loadEtaLanguageSupportManifest(root);
    expect(loaded.status).toBe("loaded");
    if (loaded.status === "loaded") {
      expect([...loaded.manifest.inputs.keys()]).toContain(path.join(root, "configs", "base.json").toLowerCase());
      expect([...loaded.manifest.inputs.keys()]).toContain(path.join(root, "node_modules", "local-model", "index.d.ts").toLowerCase());
    }
    fs.writeFileSync(path.join(root, "configs", "base.json"), "{ \"compilerOptions\": { \"strict\": false } }");
    expect(loadEtaLanguageSupportManifest(root)).toMatchObject({ status: "stale" });
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "eta-external-model-"));
    roots.push(external);
    fs.writeFileSync(path.join(external, "outside.ts"), "export interface Outside { nope: true }\n");
    expect(() => new EtaManifestBuilder({ root }).addTemplate({ path: "views/card.eta", dataType: { file: path.relative(root, path.join(external, "outside.ts")), export: "Outside" } })).toThrow("workspace root");
  });

  it("honors safe Eta instance resolution and rejects unsafe output links and oversize output", () => {
    const root = workspace();
    const eta = new Eta({ views: path.join(root, "views"), defaultExtension: ".eta" });
    const builder = new EtaManifestBuilder({ root });
    builder.addTemplate({ path: "views/card.eta", dataType: "{}", eta }).write();
    const loaded = loadEtaLanguageSupportManifest(root);
    expect(loaded.status).toBe("loaded");
    if (loaded.status === "loaded") expect(loaded.manifest.templates.values().next().value?.resolution.views).toBe(path.join(root, "views"));

    const external = fs.mkdtempSync(path.join(os.tmpdir(), "eta-output-link-"));
    roots.push(external);
    const link = path.join(root, "linked-output");
    fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => new EtaManifestBuilder({ root, output: "linked-output/manifest.json" })).toThrow("resolves outside");

    const previous = fs.readFileSync(path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST), "utf8");
    const oversized = new EtaManifestBuilder({ root });
    for (let index = 0; index < 5; index++) {
      const template = `views/large-${index}.eta`;
      fs.writeFileSync(path.join(root, template), "x");
      oversized.addTemplate({
        path: template,
        dataType: "{}",
        virtualDocument: { content: " ".repeat(Math.ceil(MAX_MANIFEST_BYTES / 4)), mappings: [{ sourceStart: 0, sourceLength: 1, virtualStart: 0, virtualLength: 1 }] },
      });
    }
    expect(() => oversized.write()).toThrow("Manifest exceeds");
    expect(fs.readFileSync(path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST), "utf8")).toBe(previous);
  });

  it("snapshots binary, model, and navigation inputs before writing", () => {
    const root = workspace();
    const metadata = path.join(root, "metadata.ts");
    fs.writeFileSync(metadata, "export const card = { title: 'Ada' };\n");
    const binary = path.join(root, "loader.bin");
    fs.writeFileSync(binary, Buffer.from([0xff]));
    const initial = new EtaManifestBuilder({ root, inputs: ["loader.bin"] });
    initial.addTemplate({ path: "views/card.eta", dataType: "{}" }).write();
    const previous = fs.readFileSync(path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST), "utf8");
    const builder = new EtaManifestBuilder({ root, inputs: ["loader.bin"] });
    builder.addTemplate({
      path: "views/card.eta",
      dataType: { file: "model.ts", export: "Card" },
      dataDefinitions: [{ dataPath: ["title"], location: { path: "metadata.ts", start: 7, length: 4 } }],
      names: [{ name: "card", definition: { path: "metadata.ts", start: 13, length: 4 } }],
      symbols: [{ id: "card", occurrences: [{ path: "metadata.ts", start: 13, length: 4, role: "definition" }] }],
    });
    fs.writeFileSync(path.join(root, "model.ts"), "export interface Card { changed: boolean }\n");
    expect(() => builder.write()).toThrow("changed after it was registered");
    expect(fs.readFileSync(path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST), "utf8")).toBe(previous);

    const binaryManifest = new EtaManifestBuilder({ root, inputs: ["loader.bin"] });
    binaryManifest.addTemplate({ path: "views/card.eta", dataType: "{}" }).write();
    fs.writeFileSync(binary, Buffer.from([0xfe]));
    expect(loadEtaLanguageSupportManifest(root)).toMatchObject({ status: "stale" });
  });

  it("ships strict TypeScript declarations for direct manifest SDK imports", () => {
    const root = workspace();
    const consumer = path.join(root, "consumer.ts");
    const declarationTarget = path.resolve("out", "manifest.js").replaceAll("\\", "/");
    fs.writeFileSync(path.join(root, "tsconfig.consumer.json"), JSON.stringify({ compilerOptions: { strict: true, module: "Node16", moduleResolution: "Node16", target: "ES2020", types: [] }, files: ["consumer.ts"] }));
    fs.writeFileSync(consumer, `import { EtaManifestBuilder, type EtaManifestTemplateOptions } from ${JSON.stringify(declarationTarget)};\nconst template: EtaManifestTemplateOptions = { path: 'views/card.eta', dataType: '{ title: string }' };\nnew EtaManifestBuilder({ root: '.' }).addTemplate(template);\n// @ts-expect-error dataType is intentionally required\nnew EtaManifestBuilder().addTemplate({ path: 'views/card.eta' });\n`);
    expect(() => execFileSync(process.execPath, [path.resolve("node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", path.join(root, "tsconfig.consumer.json")], { stdio: "pipe" })).not.toThrow();
  });

  it("rejects invalid compiler options before deriving model types", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: "yes" } }));
    const builder = new EtaManifestBuilder({ root });
    expect(() => builder.addTemplate({ path: "views/card.eta", dataType: { file: "model.ts", export: "Card" } })).toThrow(/strict/);
    expect(fs.existsSync(path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST))).toBe(false);
  });

  it("preserves the previous manifest when a build exceeds its file budget", () => {
    const root = workspace();
    new EtaManifestBuilder({ root }).addTemplate({ path: "views/card.eta", dataType: "{}" }).write();
    const output = path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST);
    const original = fs.readFileSync(output, "utf8");
    const builder = new EtaManifestBuilder({ root });
    builder.addTemplate({ path: "views/card.eta", dataType: "{}" });
    for (let index = 0; index < MAX_MANIFEST_FILES; index++) {
      const input = path.join(root, `input-${index}.txt`);
      fs.writeFileSync(input, "snapshot");
      builder.addInput(input);
    }
    expect(() => builder.write()).toThrow("split metadata across application roots");
    expect(fs.readFileSync(output, "utf8")).toBe(original);
  });

  it("rejects output collisions with inputs, metadata and generated templates", () => {
    const root = workspace();
    new EtaManifestBuilder({ root }).addTemplate({ path: "views/card.eta", dataType: "{}" }).write();
    const output = path.join(root, ETA_LANGUAGE_SUPPORT_MANIFEST);
    const original = fs.readFileSync(output, "utf8");
    expect(() => new EtaManifestBuilder({ root }).addInput(ETA_LANGUAGE_SUPPORT_MANIFEST)).toThrow("output cannot also be an input");
    expect(() => new EtaManifestBuilder({ root }).addTemplate({
      path: "views/card.eta", dataType: "{}",
      names: [{ name: "card", definition: { path: ETA_LANGUAGE_SUPPORT_MANIFEST, start: 0, length: 1 } }],
    })).toThrow("output cannot also be an input");
    const generated = ".eta-generated/card.eta";
    expect(() => new EtaManifestBuilder({ root, output: generated }).addTemplate({
      path: generated, source: "<%= it.title %>", dataType: "{ title: string }",
    })).toThrow("output cannot also be a template");
    expect(fs.existsSync(path.join(root, generated))).toBe(false);
    expect(fs.readFileSync(output, "utf8")).toBe(original);
  });

  it("orders manifest paths, relationships, aliases and symbols independently of locale", () => {
    const root = workspace();
    const names = ["é", "z", "A", "_", "ä"];
    const builder = new EtaManifestBuilder({ root });
    for (const name of names) {
      const template = `views/${name}.eta`;
      fs.writeFileSync(path.join(root, template), name);
      builder.addInput(template).addTemplate({ path: template, dataType: "{}", names: [name],
        relationships: names.filter((related) => related !== name).map((related) => `views/${related}.eta`),
        symbols: [{ id: name, occurrences: [{ path: template, start: 0, length: 1, role: "reference" }] }] });
    }
    const manifest = builder.build() as {
      templates: Array<{ path: string; relationships: string[] }>;
      templateNames: Array<{ name: string }>;
      symbols: Array<{ id: string }>;
      inputs: Array<{ path: string }>;
    };
    expect(manifest.templates.map((template) => template.path)).toEqual(names.map((name) => `views/${name}.eta`).sort());
    for (const template of manifest.templates) {
      expect(template.relationships).toEqual(names.map((name) => `views/${name}.eta`).filter((related) => related !== template.path).sort());
    }
    expect(manifest.inputs.map((input) => input.path)).toEqual(names.map((name) => `views/${name}.eta`).sort());
    expect(manifest.templateNames.map((alias) => alias.name)).toEqual([...names].sort());
    expect(manifest.symbols.map((symbol) => symbol.id)).toEqual([...names].sort());
    builder.write();
    expect(loadEtaLanguageSupportManifest(root).status).toBe("loaded");
  });
});
