import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import {
  analyzeFileForEtaCalls,
  hasInferredItTypeForUri,
  getItTypeForUri,
  templateDataDefinitionMap,
  templateDataTypeMap,
  templateLanguageOptionsMap,
  templateRegistrationMap,
  templateRelationshipMap,
  templateResolutionOptionsMap,
  workspaceEtaFiles,
} from "../src/typeInference";
import { DEFAULT_IT_TYPE } from "../src/virtualDocument";

describe("Eta usage patterns", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eta-usage-patterns-"));
    templateDataTypeMap.clear();
    templateDataDefinitionMap.clear();
    templateLanguageOptionsMap.clear();
    templateRegistrationMap.clear();
    templateRelationshipMap.clear();
    templateResolutionOptionsMap.clear();
    workspaceEtaFiles.clear();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function analyze(
    code: string,
    extraFiles: Record<string, string> = {},
    extension = ".ts",
  ): void {
    const script = path.join(root, `render${extension}`);
    fs.writeFileSync(script, code);
    for (const [name, source] of Object.entries(extraFiles)) {
      const fileName = path.join(root, name);
      fs.mkdirSync(path.dirname(fileName), { recursive: true });
      fs.writeFileSync(fileName, source);
    }
    for (const name of ["card", "detail"]) {
      const file = path.join(root, `${name}.eta`);
      fs.writeFileSync(file, "<%= it.value %>");
      workspaceEtaFiles.add(file);
    }
    const program = ts.createProgram([script], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      allowJs: true,
      noEmit: true,
      types: ["node"],
      typeRoots: [path.resolve("node_modules/@types")],
      paths: {
        eta: [path.resolve("node_modules/eta/dist/index.d.mts")],
        "eta/core": [path.resolve("node_modules/eta/dist/core.d.ts")],
      },
    });
    const source = program.getSourceFile(script);
    if (!source) throw new Error("Missing pattern fixture source");
    analyzeFileForEtaCalls(source, program.getTypeChecker());
  }

  const setup = 'import { Eta } from "eta";\nconst eta = new Eta({ views: __dirname });\n';

  it.each([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])
  ("infers data in %s sources", (extension) => {
    const commonJs = extension === ".cts" || extension === ".cjs";
    analyze(
      (commonJs ? 'const { Eta } = require("eta");\n' : 'import { Eta } from "eta";\n') +
        `const eta = new Eta({ views: ${commonJs ? "__dirname" : "import.meta.dirname"} });\n` +
        'eta.render("card", { value: "typed", counts: [1, 2] });',
      {},
      extension,
    );
    const type = getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString());
    expect(type).toMatch(/value: string/);
    expect(type).toMatch(/counts: Array<number>/);
    expect(type).not.toMatch(/\bany\b/);
  });

  it.each([
    ["ordinary method", 'eta.render("card", { value: "typed" });'],
    ["bracket method", 'eta["render"]("card", { value: "typed" });'],
    ["optional bracket method", 'eta?.["renderAsync"]("card", { value: "typed" });'],
    ["destructured instance method", 'const { render } = eta; render.call(eta, "card", { value: "typed" });'],
    ["bound method", 'const render = eta.render.bind(eta); render("card", { value: "typed" });'],
    ["partial bind", 'const render = eta.render.bind(eta, "card"); render({ value: "typed" });'],
    ["bound bracket alias", 'const render = eta["render"].bind(eta); render("card", { value: "typed" });'],
    ["call", 'eta.render.call(eta, "card", { value: "typed" });'],
    ["apply", 'eta.render.apply(eta, ["card", { value: "typed" }]);'],
  ])("recognizes %s", (_label, expression) => {
    analyze(setup + expression);
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toMatch(/value: string/);
  });

  it.each([
    ["conditional", 'declare const choice: boolean; const name = choice ? "card" : "detail";'],
    ["literal union", 'declare const name: "card" | "detail";'],
    ["constant concatenation", 'const suffix = "card"; const name = "./" + suffix;'],
    ["constant interpolation", 'const suffix = "card"; const name = `./${suffix}`;'],
  ])("resolves %s template names", (label, expression) => {
    analyze(setup + expression + '\neta.render(name, { value: "typed" });');
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toMatch(/value: string/);
    if (label === "conditional" || label === "literal union") {
      expect(getItTypeForUri(pathToFileURL(path.join(root, "detail.eta")).toString()))
        .toMatch(/value: string/);
    }
  });

  it("follows re-exported constructor aliases", () => {
    analyze(
      'import { Engine } from "./engine";\n' +
        'const eta = new Engine({ views: __dirname });\n' +
        'eta.render("card", { value: "typed" });',
      { "engine.ts": 'export { Eta as Engine } from "eta";' },
    );
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toMatch(/value: string/);
  });

  it.each([
    'import * as engine from "eta"; const eta = new engine.Eta({ views: __dirname });',
    'import engine = require("eta"); const eta = new engine.Eta({ views: __dirname });',
    'const engine = require("eta"); const { Eta: Constructor } = engine; const eta = new Constructor({ views: __dirname });',
    'const { Eta: Constructor } = require("eta/core"); const Alias = Constructor; const eta = new Alias({ views: __dirname });',
    'import { Eta } from "eta"; class Renderer { eta = new Eta({ views: __dirname }); } const eta = new Renderer().eta;',
  ])("recognizes constructor patterns: %s", (expression) => {
    analyze(expression + '\neta.render("card", { value: "typed" });');
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString())).toMatch(/value: string/);
  });

  it.each(["eta/core", "npm:eta", "npm:eta@4.6.0", "jsr:@bgub/eta", "jsr:@bgub/eta@4.6.0"])
  ("recognizes the %s import spelling", (specifier) => {
    analyze(
      `import { Eta as Engine } from ${JSON.stringify(specifier)};\n` +
        "const eta = new Engine({ views: __dirname });\n" +
        'eta.render("card", { value: "typed" });',
    );
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toMatch(/value: string/);
  });

  it("keeps configured paths on simple factory-returned instances", () => {
    const directory = path.join(root, "views");
    fs.mkdirSync(directory);
    const template = path.join(directory, "card.eta");
    fs.writeFileSync(template, "<%= it.value %>");
    workspaceEtaFiles.add(template);
    analyze(
      'import { Eta } from "eta";\n' +
        'import path from "node:path";\n' +
        'function createEta() { return new Eta({ views: path.join(__dirname, "views") }); }\n' +
        'const eta = createEta(); eta.render("card", { value: "typed" });',
    );
    expect(getItTypeForUri(pathToFileURL(template).toString())).toMatch(/value: string/);
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toBe(DEFAULT_IT_TYPE);
  });

  it("substitutes parameterized factory config independently per call", () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    for (const [directory, value] of [[first, "first"], [second, "second"]] as const) {
      const template = path.join(directory, "card.eta");
      fs.writeFileSync(template, "<%= it.value %>");
      workspaceEtaFiles.add(template);
      void value;
    }
    analyze('import { Eta } from "eta";\n' +
      'function createEta(views: string = __dirname) { const options = { views }; return new Eta(options); }\n' +
      `const first = createEta(${JSON.stringify(first)});\n` +
      `const second = createEta(${JSON.stringify(second)});\n` +
      'first.render("card", { value: "one", firstOnly: true });\n' +
      'second.render("card", { value: "two", secondOnly: 1 });');
    const firstType = getItTypeForUri(pathToFileURL(path.join(first, "card.eta")).toString());
    const secondType = getItTypeForUri(pathToFileURL(path.join(second, "card.eta")).toString());
    expect(firstType).toMatch(/firstOnly: boolean/);
    expect(firstType).not.toContain("secondOnly");
    expect(secondType).toMatch(/secondOnly: number/);
    expect(secondType).not.toContain("firstOnly");
  });

  it("follows a nested options factory without mixing call-site paths", () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    for (const directory of [first, second]) {
      fs.mkdirSync(directory);
      const template = path.join(directory, "card.eta");
      fs.writeFileSync(template, "<%= it.value %>");
      workspaceEtaFiles.add(template);
    }
    analyze('import { Eta } from "eta";\n' +
      'function createRawOptions(views: string) { const resolvedViews = views; return { views: resolvedViews }; }\n' +
      'function createOptions(views: string) { return createRawOptions(views); }\n' +
      'function createEta(views: string) { return new Eta(createOptions(views)); }\n' +
      `const first = createEta(${JSON.stringify(first)});\n` +
      `const second = createEta(${JSON.stringify(second)});\n` +
      'first.render("card", { value: "one", firstOnly: true });\n' +
      'second.render("card", { value: "two", secondOnly: 1 });');
    const firstType = getItTypeForUri(pathToFileURL(path.join(first, "card.eta")).toString());
    const secondType = getItTypeForUri(pathToFileURL(path.join(second, "card.eta")).toString());
    expect(firstType).toMatch(/firstOnly: boolean/);
    expect(firstType).not.toContain("secondOnly");
    expect(secondType).toMatch(/secondOnly: number/);
    expect(secondType).not.toContain("firstOnly");
  });

  it("resolves imported factory defaults relative to the factory module", () => {
    const template = path.join(root, "lib", "views", "card.eta");
    fs.mkdirSync(path.dirname(template), { recursive: true });
    fs.writeFileSync(template, "<%= it.value %>");
    workspaceEtaFiles.add(template);
    analyze(
      'import { createEta } from "./lib/factory";\n' +
        'const eta = createEta(); eta.render("card", { value: "imported", importedOnly: true });',
      {
        "lib/factory.ts": 'import { Eta } from "eta"; import path from "node:path";\n' +
          'export function createEta(views = path.join(__dirname, "views")) {\n' +
          '  const options = { views }; return new Eta(options);\n' +
          '}',
      },
    );
    expect(getItTypeForUri(pathToFileURL(template).toString())).toMatch(/importedOnly: boolean/);
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toBe(DEFAULT_IT_TYPE);
  });

  it.each([
    'function createEta(views: string) { const options = { views }; options.views = __dirname; return new Eta(options); }',
    'function createEta(views: string) { if (Date.now()) return new Eta({ views }); return new Eta({ views: __dirname }); }',
  ])("does not choose a duplicate template from an unsafe factory: %s", (factory) => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    for (const directory of [first, second]) {
      fs.mkdirSync(directory);
      const template = path.join(directory, "card.eta");
      fs.writeFileSync(template, "<%= it.value %>");
      workspaceEtaFiles.add(template);
    }
    analyze('import { Eta } from "eta";\n' + factory + '\n' +
      `const eta = createEta(${JSON.stringify(first)});\n` +
      'eta.render("card", { value: "unsafe" });');
    expect(getItTypeForUri(pathToFileURL(path.join(first, "card.eta")).toString()))
      .toBe(DEFAULT_IT_TYPE);
    expect(getItTypeForUri(pathToFileURL(path.join(second, "card.eta")).toString()))
      .toBe(DEFAULT_IT_TYPE);
  });

  it.each([
    ["TypeScript", "wrapper.ts", 'export function renderTemplate(engine: import("eta").Eta, name: string, data: { value: string }) { engine.render(name, data); }', 'import { renderTemplate } from "./wrapper";', 'renderTemplate'],
    ["JavaScript", "wrapper.js", '/** @param {import("eta").Eta} engine @param {string} name @param {{ value: string }} data */\nexport function renderTemplate(engine, name, data) { engine.render(name, data); }', 'import { renderTemplate } from "./wrapper.js";', 'renderTemplate'],
    ["CommonJS", "wrapper.ts", 'import { Eta } from "eta"; export = { renderTemplate(engine: Eta, name: string, data: { value: string }) { engine.render(name, data); } };', 'import wrapper = require("./wrapper");', 'wrapper.renderTemplate'],
  ])("forwards imported %s wrappers", (_kind, fileName, wrapper, importer, callee) => {
    analyze(importer + '\n' + setup + `${callee}(eta, "card", { value: "imported" });`, { [fileName]: wrapper });
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString())).toMatch(/value: string/);
  });

  it.each([
    'function renderTemplate(engine: Eta, name: string, data: { value: string }) { engine.render(name, data); }\nrenderTemplate(eta, "card", { value: "wrapped" });',
    'function renderTemplate(engine: Eta, name = "card", data = { value: "defaulted" }) { engine.render(name, data); }\nrenderTemplate(eta);',
    'const renderTemplate = (engine: Eta, name: string, data: { value: string }) => engine.render(name, data);\nrenderTemplate(eta, "card", { value: "arrow" });',
    'function inner(engine: Eta, name: string, data: { value: string }) { engine.render(name, data); }\nfunction outer(engine: Eta, name: string, data: { value: string }) { inner(engine, name, data); }\nouter(eta, "card", { value: "nested" });',
  ])("forwards bounded synchronous wrappers: %s", (wrapper) => {
    analyze(setup + wrapper);
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toMatch(/value: string/);
  });

  it.each([
    'function recurse(engine: Eta, name: string, data: { value: string }) { recurse(engine, name, data); }\nrecurse(eta, "card", { value: "bad" });',
    'let name = "card"; function renderTemplate(engine: Eta, data: { value: string }) { engine.render(name, data); }\nname = "detail"; renderTemplate(eta, { value: "bad" });',
    'function renderTemplate(engine: Eta, ...args: [string, { value: string }]) { engine.render(...args); }\nrenderTemplate(eta, "card", { value: "bad" });',
  ])("rejects unsafe wrapper forwarding: %s", (wrapper) => {
    analyze(setup + wrapper);
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toBe(DEFAULT_IT_TYPE);
  });

  it("keeps finite preview-record template and data pairs together", () => {
    analyze(setup +
      'const previews: Record<"card" | "detail", { template: string; data: object }> = {\n' +
      '  card: { template: "card", data: { value: "card-value", cardOnly: true } },\n' +
      '  detail: { template: "detail", data: { value: "detail-value", detailOnly: 1 } },\n' +
      '};\n' +
      'declare const key: "card" | "detail";\n' +
      'eta.render(previews[key].template, previews[key].data);',
    );
    const card = getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString());
    const detail = getItTypeForUri(pathToFileURL(path.join(root, "detail.eta")).toString());
    expect(card).toMatch(/cardOnly: boolean/);
    expect(card).not.toContain("detailOnly");
    expect(detail).toMatch(/detailOnly: number/);
    expect(detail).not.toContain("cardOnly");
  });

  it("distinguishes missing evidence from an inferred default-like data shape", () => {
    const uri = pathToFileURL(path.join(root, "card.eta")).toString();
    expect(hasInferredItTypeForUri(uri)).toBe(false);
    templateDataTypeMap.set(path.join(root, "card.eta").toLowerCase(), "Record<string, unknown>");
    expect(hasInferredItTypeForUri(uri)).toBe(true);
  });

  it("preserves explicit JSDoc any as application-owned type evidence", () => {
    analyze(
      'const { Eta } = require("eta");\n' +
        'const eta = new Eta({ views: __dirname });\n' +
        '/** @type {any} */ const data = {};\n' +
        'eta.render("card", data);',
      {},
      ".js",
    );
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toBe("any");
  });

  it("preserves explicit JSDoc parameter any as application-owned type evidence", () => {
    analyze(
      'const { Eta } = require("eta");\n' +
        'const eta = new Eta({ views: __dirname });\n' +
        '/** @param {*} data */ function renderCard(data) { eta.render("card", data); }',
      {},
      ".js",
    );
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toBe("any");
  });

  it("unwraps fileURLToPath when reading template source", () => {
    analyze(setup +
      'import { readFileSync } from "node:fs";\n' +
      'import { fileURLToPath } from "node:url";\n' +
      'const source = readFileSync(fileURLToPath(new URL("./card.eta", import.meta.url)), "utf8");\n' +
      'eta.renderString(source, { value: "typed" });',
    );
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toMatch(/value: string/);
  });

  it.each([
    'import { readFileSync as load } from "node:fs"; import path from "node:path"; const source = load(path.join(__dirname, "card.eta"), "utf8");',
    'import { readFile as load } from "node:fs/promises"; const source = await load(new URL("./card.eta", import.meta.url), "utf8");',
    'import fs from "node:fs"; import path from "node:path"; const source = fs.readFileSync(path.join(__dirname, "card.eta"), "utf8");',
    'import { readFileSync } from "node:fs"; import { fileURLToPath as toPath } from "node:url"; const source = readFileSync(toPath(new URL("./card.eta", import.meta.url)), "utf8");',
    'import path from "node:path"; const source = eta.readFile(path.join(__dirname, "card.eta"));',
    'const fs = require("node:fs"); const path = require("node:path"); const source = fs.readFileSync(path.join(__dirname, "card.eta"), "utf8");',
    'const { readFileSync: load } = require("node:fs"); const path = require("node:path"); const source = load(path.join(__dirname, "card.eta"), "utf8");',
  ])("traces file-backed renderString sources: %s", (expression) => {
    analyze(setup + expression + '\neta.renderString(source, { value: "typed" });');
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString())).toMatch(/value: string/);
  });

  it.each([
    'const factory = () => new Eta({ views: __dirname });',
    'const factory = function () { return new Eta({ views: __dirname }); };',
  ])("retains config through a simple factory: %s", (expression) => {
    analyze('import { Eta } from "eta";\n' + expression + '\nconst eta = factory(); eta.render("card", { value: "typed" });');
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString())).toMatch(/value: string/);
  });

  it.each([
    'async function factory() { return new Eta({ views: __dirname }); }',
    'function* factory() { return new Eta({ views: __dirname }); }',
    'function factory(): unknown { return factory(); }',
    'const factory = (): unknown => factory();',
  ])("does not treat Promise, Generator or recursive factories as Eta: %s", (expression) => {
    analyze('import { Eta } from "eta";\n' + expression + '\nconst eta = factory(); eta.render("card", { value: "bad" });');
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString())).toBe(DEFAULT_IT_TYPE);
  });

  it("does not infer unconstrained names or unrelated render methods", () => {
    analyze(setup +
      'declare const name: string; eta.render(name, { value: "dynamic" });\n' +
      'const unrelated = { render(name: string, data: object) {} };\n' +
      'unrelated["render"]("card", { value: "unrelated" });\n' +
      'eta.renderString("card", { value: "inline" });',
    );
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString()))
      .toBe(DEFAULT_IT_TYPE);
    expect(getItTypeForUri(pathToFileURL(path.join(root, "detail.eta")).toString()))
      .toBe(DEFAULT_IT_TYPE);
  });

  it.each([
    'let name = "card"; name = String(Date.now()); eta.render(name, { value: "bad" });',
    'const names = { current: "card" }; names.current = String(Date.now()); eta.render(names.current, { value: "bad" });',
    'class Names { current = "card"; } const names = new Names(); names.current = String(Date.now()); eta.render(names.current, { value: "bad" });',
    'let render = eta.render.bind(eta); render = (() => ""); render("card", { value: "bad" });',
    'const { render } = eta; render("card", { value: "bad" });',
    'const other = { render() {} }; eta.render.call(other, "card", { value: "bad" });',
    'import { Eta as Fake } from "npm:eta-unrelated"; const fake = new Fake(); fake.render("card", { value: "bad" });',
    'const path = { resolve: (...args: string[]) => "somewhere-else" }; const other = new Eta({ views: path.resolve(__dirname) }); other.render("missing", { value: "bad" });',
    'const other = { readFileSync: () => "card" }; eta.renderString(other.readFileSync("card.eta"), { value: "bad" });',
    'import { readFileSync } from "node:fs"; eta.renderString(readFileSync("./card.eta", "utf8"), { value: "bad" });',
  ])("keeps unsupported or unsafe patterns unresolved: %s", (expression) => {
    analyze(setup + expression);
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString())).toBe(DEFAULT_IT_TYPE);
  });

  it("decodes URL paths with spaces in file-backed renderString", () => {
    const template = path.join(root, "my card.eta");
    fs.writeFileSync(template, "<%= it.value %>");
    workspaceEtaFiles.add(template);
    analyze(setup + 'import { readFileSync } from "node:fs";\n' +
      'const source = readFileSync(new URL("./my%20card.eta", import.meta.url), "utf8");\n' +
      'eta.renderString(source, { value: "typed" });');
    expect(getItTypeForUri(pathToFileURL(template).toString())).toMatch(/value: string/);
  });

  it("traces Eta's explicit resolvePath through configured views", () => {
    const directory = path.join(root, "views");
    fs.mkdirSync(directory);
    const template = path.join(directory, "card.eta");
    fs.writeFileSync(template, "<%= it.value %>");
    workspaceEtaFiles.add(template);
    analyze('import { Eta } from "eta"; import path from "node:path";\n' +
      'const eta = new Eta({ views: path.join(__dirname, "views") });\n' +
      'const source = eta.readFile(eta.resolvePath("card"));\n' +
      'eta.renderString(source, { value: "typed" });');
    expect(getItTypeForUri(pathToFileURL(template).toString())).toMatch(/value: string/);
    expect(getItTypeForUri(pathToFileURL(path.join(root, "card.eta")).toString())).toBe(DEFAULT_IT_TYPE);
  });
});
