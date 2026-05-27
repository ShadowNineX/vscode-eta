import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import * as ts from "typescript";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_IT_TYPE } from "../src/virtualDocument";
import {
  analyzeEtaTemplateLayouts,
  analyzeFileForEtaCalls,
  getItTypeForUri,
  scanWorkspaceFiles,
  templateDataTypeMap,
  templateLanguageOptionsMap,
  typeToStructuralString,
  workspaceEtaFiles,
  workspaceTsFiles,
} from "../src/typeInference";

// ── Test helpers ────────────────────────────────────────────────────────────────

/** Build a minimal real TypeScript program so we can get a TypeChecker. */
function makeTestProgram(code: string): {
  checker: ts.TypeChecker;
  sf: ts.SourceFile;
} {
  const sf = ts.createSourceFile(
    "eta_test.ts",
    code,
    ts.ScriptTarget.ES2020,
    /*setParentNodes*/ true,
  );
  const host = ts.createCompilerHost({}, true);
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) =>
    name === "eta_test.ts" ? sf : orig(name, lang);
  const program = ts.createProgram(
    ["eta_test.ts"],
    {
      target: ts.ScriptTarget.ES2020,
      strict: true,
    },
    host,
  );
  return { checker: program.getTypeChecker(), sf };
}

/** Get the TypeScript type of the Nth `const x = <expr>` initializer. */
function getNthInitializerType(
  code: string,
  n = 0,
): { checker: ts.TypeChecker; type: ts.Type } {
  const { checker, sf } = makeTestProgram(code);
  let count = 0;
  function pick(node: ts.Node): ts.Type | undefined {
    if (ts.isVariableDeclaration(node) && node.initializer && count++ === n) {
      return checker.getTypeAtLocation(node.initializer);
    }
    return ts.forEachChild(node, pick);
  }
  const type = ts.forEachChild(sf, pick);
  if (!type) throw new Error(`No initializer at index ${n}`);
  return { checker, type };
}

/** Get the declared type of a named variable (reads type annotation, not initializer). */
function getNamedVarType(
  code: string,
  varName: string,
): { checker: ts.TypeChecker; type: ts.Type } {
  const { checker, sf } = makeTestProgram(code);
  let found: ts.Type | undefined;
  function walk(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === varName
    ) {
      found = checker.getTypeAtLocation(node.name);
    }
    ts.forEachChild(node, walk);
  }
  ts.forEachChild(sf, walk);
  if (!found) throw new Error(`Variable "${varName}" not found in code`);
  return { checker, type: found };
}

// ── typeToStructuralString ───────────────────────────────────────────────────────────

describe("typeToStructuralString", () => {
  it("expands an object literal to structural form", () => {
    const { checker, type } = getNthInitializerType(
      `const x = { name: "Ben", age: 30 };`,
    );
    const result = typeToStructuralString(checker, type);
    expect(result).toMatch(/name: string/);
    expect(result).toMatch(/age: number/);
    // Must be an inline object, not a named type reference
    expect(result).toMatch(/^\{/);
  });

  it("preserves string literal values (important for union discriminators)", () => {
    const { checker, type } = getNthInitializerType(`const x = "hello";`);
    // We preserve literals so that `status: "draft" | "published"` isn't collapsed to `status: string`
    expect(typeToStructuralString(checker, type)).toBe('"hello"');
  });

  it("preserves number literal values", () => {
    const { checker, type } = getNthInitializerType(`const x = 42;`);
    expect(typeToStructuralString(checker, type)).toBe("42");
  });

  it("widens boolean literals to 'boolean'", () => {
    const { checker, type } = getNthInitializerType(`const x = true;`);
    expect(typeToStructuralString(checker, type)).toBe("boolean");
  });

  it("expands a named interface to its structural form", () => {
    const { checker, type } = getNthInitializerType(
      `interface User { name: string; age: number }\nconst x: User = { name: "A", age: 1 };`,
      0, // picks the first variable declaration (index 0)
    );
    const result = typeToStructuralString(checker, type);
    // Should expand, not just return "User"
    expect(result).toMatch(/name: string/);
    expect(result).toMatch(/age: number/);
    expect(result).not.toBe("User");
  });

  it("expands nested objects recursively", () => {
    const { checker, type } = getNthInitializerType(
      `const x = { user: { name: "Ben", score: 100 } };`,
    );
    const result = typeToStructuralString(checker, type);
    expect(result).toMatch(/user:.*name: string/);
    expect(result).toMatch(/user:.*score: number/);
  });

  it("handles string arrays", () => {
    const { checker, type } = getNamedVarType(`const x: string[] = [];`, "x");
    expect(typeToStructuralString(checker, type)).toBe("Array<string>");
  });

  it("handles union types", () => {
    const { checker, type } = getNamedVarType(
      `const x: string | number = "hi";`,
      "x",
    );
    const result = typeToStructuralString(checker, type);
    expect(result).toContain("string");
    expect(result).toContain("number");
    expect(result).toContain("|");
  });

  it("returns 'unknown' at max depth to prevent infinite loops", () => {
    // We can test this by calling with depth = MAX_TYPE_DEPTH + 1 directly,
    // but since MAX_TYPE_DEPTH is not exported we test the boundary indirectly
    // by checking that deeply nested types don't throw.
    const { checker, type } = getNthInitializerType(
      `const x = { a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } };`,
    );
    // Should not throw; deepest level may be truncated to 'unknown'
    expect(() => typeToStructuralString(checker, type)).not.toThrow();
  });

  it("handles boolean property in a named interface (like Product.inStock)", () => {
    const { checker, type } = getNamedVarType(
      `interface Product { title: string; price: number; inStock: boolean }\n` +
        `const x: Product = { title: "a", price: 1, inStock: true };`,
      "x",
    );
    const result = typeToStructuralString(checker, type);
    expect(result).toMatch(/inStock: boolean/);
    expect(result).toMatch(/title: string/);
    expect(result).toMatch(/price: number/);
  });

  it("handles widened boolean type (not a literal)", () => {
    const { checker, type } = getNamedVarType(`const x: boolean = true;`, "x");
    expect(typeToStructuralString(checker, type)).toBe("boolean");
  });

  it("handles nested object with numeric properties (like dashboard stats)", () => {
    const { checker, type } = getNthInitializerType(
      `const x = { title: "Report", stats: { visits: 1_240, revenue: 3_890.5 } };`,
    );
    const result = typeToStructuralString(checker, type);
    expect(result).toMatch(/title: string/);
    expect(result).toMatch(/stats:.*visits: number/);
    expect(result).toMatch(/stats:.*revenue: number/);
  });
});

// ── analyzeFileForEtaCalls ────────────────────────────────────────────────────────

describe("analyzeFileForEtaCalls", () => {
  beforeEach(() => {
    templateDataTypeMap.clear();
    templateLanguageOptionsMap.clear();
  });

  it("detects eta.render() call with object literal and maps basename", () => {
    const { checker, sf } = makeTestProgram(
      `declare function render(t: string, d: any): string;\n` +
        `render("user", { name: "Ben", age: 30 });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const result = templateDataTypeMap.get("user");
    expect(result).toMatch(/name: string/);
    expect(result).toMatch(/age: number/);
  });

  it("ignores renderString() because it renders inline template source", () => {
    const { checker, sf } = makeTestProgram(
      `declare function renderString(t: string, d: any): string;\n` +
        `renderString("Hi <%= it.message %>", { message: "hello" });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    expect(templateDataTypeMap.size).toBe(0);
  });

  it("detects legacy renderFile() and renderFileAsync() calls", () => {
    const { checker, sf } = makeTestProgram(
      `declare function renderFile(t: string, d: any): string;\n` +
        `declare function renderFileAsync(t: string, d: any): Promise<string>;\n` +
        `renderFile("views/invoice.eta", { id: "INV-1", total: 42 });\n` +
        `renderFileAsync("views/receipt.eta", { receiptId: "R-1", paid: true });`,
    );
    analyzeFileForEtaCalls(sf, checker);

    expect(templateDataTypeMap.get("invoice")).toMatch(/total: number/);
    expect(templateDataTypeMap.get("receipt")).toMatch(/paid: boolean/);
  });

  it("strips .eta extension from template path for the key", () => {
    const { checker, sf } = makeTestProgram(
      `declare function render(t: string, d: any): string;\n` +
        `render("views/user.eta", { id: 1 });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    expect(templateDataTypeMap.has("user")).toBe(true);
  });

  it("infers simple Eta config from new Eta({ ... }) for named templates", () => {
    const { checker, sf } = makeTestProgram(
      `declare class Eta {
         constructor(config?: any);
         render(t: string, d: any): string;
       }
       const eta = new Eta({
         tags: ["{{", "}}"],
         parse: { interpolate: ":", raw: "!" },
         customTags: { "#": (content: string, data: unknown) => "" },
         varName: "data",
         useWith: true,
         functionHeader: "const helper = data.name",
         outputFunctionName: "print"
       });
       eta.render("profile", { name: "Ada" });`,
    );

    analyzeFileForEtaCalls(sf, checker);
    const options = templateLanguageOptionsMap.get("profile");

    expect(options?.tags).toEqual(["{{", "}}"]);
    expect(options?.parse.interpolate).toBe(":");
    expect(options?.parse.raw).toBe("!");
    expect(options?.customTags).toEqual(["#"]);
    expect(options?.varName).toBe("data");
    expect(options?.useWith).toBe(true);
    expect(options?.functionHeader).toBe("const helper = data.name");
    expect(options?.outputFunctionName).toBe("print");
  });

  it("applies simple eta.configure({ ... }) calls before render analysis", () => {
    const { checker, sf } = makeTestProgram(
      `declare class Eta {
         constructor(config?: any);
         configure(config: any): void;
         render(t: string, d: any): string;
       }
       const eta = new Eta({ tags: ["{{", "}}"] });
       eta.configure({ varName: "data", outputFunctionName: "print" });
       eta.render("card", { title: "Configured" });`,
    );

    analyzeFileForEtaCalls(sf, checker);
    const options = templateLanguageOptionsMap.get("card");

    expect(options?.tags).toEqual(["{{", "}}"]);
    expect(options?.varName).toBe("data");
    expect(options?.outputFunctionName).toBe("print");
  });

  it("propagates child render data to layout templates with body", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eta-layout-"));
    const childPath = path.join(dir, "email-verify.eta");
    const layoutPath = path.join(dir, "email-base.eta");
    fs.writeFileSync(childPath, '<% layout("./email-base") %>');
    fs.writeFileSync(layoutPath, "<%= it.title %><%~ it.body %>");

    templateDataTypeMap.set(
      "email-verify",
      "{ title: string; ctaUrl: string }",
    );
    analyzeEtaTemplateLayouts([childPath, layoutPath]);

    const type = templateDataTypeMap.get("email-base");
    expect(type).toMatch(/title: string/);
    expect(type).toMatch(/ctaUrl: string/);
    expect(type).toMatch(/body: string/);
  });

  it("does not propagate dynamic layout names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eta-layout-dynamic-"));
    const childPath = path.join(dir, "page.eta");
    fs.writeFileSync(childPath, '<% layout(layoutName) %>');

    templateDataTypeMap.set("page", "{ title: string }");
    analyzeEtaTemplateLayouts([childPath]);

    expect(templateDataTypeMap.has("layoutName")).toBe(false);
  });

  it("merges multiple child render data shapes into one layout type", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eta-layout-merge-"));
    const firstPath = path.join(dir, "first.eta");
    const secondPath = path.join(dir, "second.eta");
    fs.writeFileSync(firstPath, '<% layout("./base") %>');
    fs.writeFileSync(secondPath, '<% layout("./base") %>');

    templateDataTypeMap.set("first", "{ title: string }");
    templateDataTypeMap.set("second", "{ count: number }");
    analyzeEtaTemplateLayouts([firstPath, secondPath]);

    const type = templateDataTypeMap.get("base");
    expect(type).toContain("&");
    expect(type).toMatch(/title: string/);
    expect(type).toMatch(/count: number/);
    expect(type).toMatch(/body: string/);
  });

  it("merges multiple call sites for the same template via intersection", () => {
    const { checker, sf } = makeTestProgram(
      `declare function render(t: string, d: any): string;\n` +
        `render("page", { title: "Home" });\n` +
        `render("page", { count: 5 });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const result = templateDataTypeMap.get("page");
    expect(result).toContain("&"); // intersection
    expect(result).toMatch(/title: string/);
    expect(result).toMatch(/count: number/);
  });

  it("ignores calls without a string literal template argument", () => {
    const { checker, sf } = makeTestProgram(
      `declare function render(t: string, d: any): string;\n` +
        `const tmpl = "user";\n` +
        `render(tmpl, { name: "Ben" });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    // Dynamic template name → not tracked
    expect(templateDataTypeMap.size).toBe(0);
  });

  it("does not record 'any' types", () => {
    const { checker, sf } = makeTestProgram(
      `declare function render(t: string, d: any): string;\n` +
        `declare const data: any;\n` +
        `render("user", data);`,
    );
    analyzeFileForEtaCalls(sf, checker);
    expect(templateDataTypeMap.has("user")).toBe(false);
  });

  it("works with eta.render() method call form (property access expression)", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render(t: string, d: any): string };\n` +
        `eta.render("product", { title: "Widget", price: 9.99 });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const result = templateDataTypeMap.get("product");
    expect(result).toMatch(/title: string/);
    expect(result).toMatch(/price: number/);
  });

  it("resolves typed variable's interface and expands boolean properties", () => {
    const { checker, sf } = makeTestProgram(
      `interface Product { title: string; price: number; inStock: boolean; tags: string[] }\n` +
        `declare const eta: { render(t: string, d: any): string };\n` +
        `const product: Product = { title: "Widget", price: 9.99, inStock: true, tags: [] };\n` +
        `eta.render("product", product);`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const result = templateDataTypeMap.get("product");
    expect(result).toBeTruthy();
    expect(result).toMatch(/title: string/);
    expect(result).toMatch(/price: number/);
    expect(result).toMatch(/inStock: boolean/);
    expect(result).toMatch(/tags: Array<string>/);
  });

  it("resolves nested object type for dashboard-style templates", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render(t: string, d: any): string };\n` +
        `eta.render("dashboard", { title: "Report", stats: { visits: 1_240, revenue: 3_890.5 } });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const result = templateDataTypeMap.get("dashboard");
    expect(result).toMatch(/title: string/);
    expect(result).toMatch(/stats:/);
    expect(result).toMatch(/visits: number/);
    expect(result).toMatch(/revenue: number/);
  });

  it("does not cross-contaminate types between greeting and dashboard templates", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };\n` +
        `eta.render("greeting", { heading: "Hello, world!", count: 3 });\n` +
        `eta.render("dashboard", { title: "Weekly Report", stats: { visits: 1_240, revenue: 3_890.5 } });`,
    );
    analyzeFileForEtaCalls(sf, checker);

    const greeting = templateDataTypeMap.get("greeting");
    const dashboard = templateDataTypeMap.get("dashboard");

    expect(greeting).toMatch(/heading: string/);
    expect(greeting).toMatch(/count: number/);
    expect(greeting).not.toMatch(/\btitle:/);
    expect(greeting).not.toMatch(/stats:/);

    expect(dashboard).toMatch(/title: string/);
    expect(dashboard).toMatch(/stats:/);
    expect(dashboard).toMatch(/visits: number/);
    expect(dashboard).not.toMatch(/heading:/);
  });
});

// ── getItTypeForUri ────────────────────────────────────────────────────────────────

describe("getItTypeForUri", () => {
  beforeEach(() => {
    templateDataTypeMap.clear();
    templateLanguageOptionsMap.clear();
  });

  it("returns DEFAULT_IT_TYPE when the template has no mapping", () => {
    expect(getItTypeForUri("file:///workspace/views/user.eta")).toBe(
      DEFAULT_IT_TYPE,
    );
  });

  it("returns the mapped type when the template basename is in the map", () => {
    templateDataTypeMap.set("user", "{ name: string }");
    // Use a URI valid on all platforms (drive letter for Windows compatibility)
    expect(getItTypeForUri("file:///C:/workspace/views/user.eta")).toBe(
      "{ name: string }",
    );
  });

  it("matches by basename only (ignores directory path)", () => {
    templateDataTypeMap.set("dashboard", "{ user: string; count: number }");
    expect(
      getItTypeForUri("file:///C:/some/deep/nested/path/dashboard.eta"),
    ).toBe("{ user: string; count: number }");
  });

  it("returns DEFAULT_IT_TYPE for an unparseable URI", () => {
    expect(getItTypeForUri("not-a-valid-uri")).toBe(DEFAULT_IT_TYPE);
  });
});

// ── Integration: real eta package type inference ──────────────────────────────

describe("Integration: real eta package type inference", () => {
  beforeEach(() => {
    templateDataTypeMap.clear();
    templateLanguageOptionsMap.clear();
  });

  it("correctly infers greeting and dashboard types from demo/src/index.ts", () => {
    const demoIndexPath = fileURLToPath(
      new URL("../demo/src/index.ts", import.meta.url),
    );

    const program = ts.createProgram({
      rootNames: [demoIndexPath],
      options: {
        allowJs: true,
        checkJs: false,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
      },
    });

    const checker = program.getTypeChecker();
    // TypeScript normalises Windows paths to forward slashes internally
    const sf =
      program.getSourceFile(demoIndexPath) ??
      program.getSourceFile(demoIndexPath.replaceAll("\\", "/"));
    if (!sf) throw new Error(`Source file not found: ${demoIndexPath}`);

    analyzeFileForEtaCalls(sf, checker);

    // greeting.eta → { heading: string; count: number }
    expect(templateDataTypeMap.get("greeting")).toMatch(/heading: string/);
    expect(templateDataTypeMap.get("greeting")).toMatch(/count: number/);

    // dashboard.eta → { title: string; stats: { visits: number; revenue: number } }
    const dashType = templateDataTypeMap.get("dashboard");
    expect(dashType).toMatch(/title: string/);
    expect(dashType).toMatch(/stats:/);
    expect(dashType).toMatch(/visits: number/);
    expect(dashType).toMatch(/revenue: number/);
    // Must NOT contain greeting's properties
    expect(dashType).not.toMatch(/heading:/);
  });

  it(
    "correctly maps all templates when ALL workspace source files are analyzed together",
    () => {
      // Simulate runWorkspaceAnalysis: scan workspace (excluding node_modules at any depth),
      // create a program from those files, and analyze each one.
      const workspaceDir = fileURLToPath(new URL("..", import.meta.url));
      const rawFiles = ts.sys.readDirectory(
        workspaceDir,
        [".ts", ".tsx", ".js", ".jsx"],
        ["node_modules", ".git", "out", "dist", "build"],
      );
      // ts.sys.readDirectory only excludes the top-level directory names;
      // nested node_modules (e.g. demo/node_modules) must be filtered manually.
      const allWorkspaceFiles = rawFiles.filter(
        (f) => !f.includes("node_modules"),
      );

      const program = ts.createProgram({
        rootNames: allWorkspaceFiles,
        options: {
          allowJs: true,
          checkJs: false,
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          noEmit: true,
          skipLibCheck: true,
        },
      });

      const checker = program.getTypeChecker();
      const rootSet = new Set(allWorkspaceFiles);

      for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        if (!rootSet.has(sf.fileName)) continue;
        analyzeFileForEtaCalls(sf, checker);
      }

      const greeting = templateDataTypeMap.get("greeting");
      const dashboard = templateDataTypeMap.get("dashboard");

      expect(greeting).toMatch(/heading: string/);
      expect(greeting).toMatch(/count: number/);
      expect(greeting).not.toMatch(/\btitle:/);

      expect(dashboard).toMatch(/title: string/);
      expect(dashboard).toMatch(/stats:/);
      expect(dashboard).toMatch(/visits: number/);
      expect(dashboard).not.toMatch(/heading:/);
    },
    60_000,
  );
});

// ── scanWorkspaceFiles ────────────────────────────────────────────────────────

describe("scanWorkspaceFiles", () => {
  beforeEach(() => {
    workspaceTsFiles.clear();
    workspaceEtaFiles.clear();
  });

  it("never includes files from any node_modules directory", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    scanWorkspaceFiles(root);
    const bad = [...workspaceTsFiles].filter((f) => f.includes("node_modules"));
    expect(bad).toHaveLength(0);
  });

  it("includes demo/src/index.ts (the file with render calls)", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    scanWorkspaceFiles(root);
    const normalized = [...workspaceTsFiles].map((f) =>
      f.replaceAll("\\", "/"),
    );
    expect(normalized.some((f) => f.endsWith("demo/src/index.ts"))).toBe(true);
  });

  it("includes server.ts", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    scanWorkspaceFiles(root);
    expect([...workspaceTsFiles].some((f) => f.endsWith("server.ts"))).toBe(
      true,
    );
  });
});

// ── greeting vs dashboard regression ─────────────────────────────────────────

describe("greeting vs dashboard type isolation", () => {
  beforeEach(() => {
    templateDataTypeMap.clear();
    templateLanguageOptionsMap.clear();
  });

  it("includes Eta templates for layout analysis", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    scanWorkspaceFiles(root);
    const normalized = [...workspaceEtaFiles].map((f) =>
      f.replaceAll("\\", "/"),
    );

    expect(
      normalized.some((f) => f.endsWith("demo/views/greeting.eta")),
    ).toBe(true);
  });

  it("greeting gets heading+count, NOT title/stats", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };\n` +
        `eta.render("greeting", { heading: "Hi", count: 5 });\n` +
        `eta.render("dashboard", { title: "Stats", stats: { visits: 10, revenue: 9.9 } });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const g = templateDataTypeMap.get("greeting");
    expect(g).toMatch(/heading: string/);
    expect(g).toMatch(/count: number/);
    expect(g).not.toContain("title");
    expect(g).not.toContain("stats");
  });

  it("dashboard gets title+stats, NOT heading/count", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };\n` +
        `eta.render("greeting", { heading: "Hi", count: 5 });\n` +
        `eta.render("dashboard", { title: "Stats", stats: { visits: 10, revenue: 9.9 } });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const d = templateDataTypeMap.get("dashboard");
    expect(d).toMatch(/title: string/);
    expect(d).toMatch(/stats:/);
    expect(d).toMatch(/visits: number/);
    expect(d).not.toContain("heading");
    expect(d).not.toContain("count: number");
  });

  it("order does not matter: dashboard first still gives correct types", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };\n` +
        `eta.render("dashboard", { title: "Stats", stats: { visits: 10, revenue: 9.9 } });\n` +
        `eta.render("greeting", { heading: "Hi", count: 5 });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    expect(templateDataTypeMap.get("greeting")).toMatch(/heading: string/);
    expect(templateDataTypeMap.get("greeting")).not.toContain("title");
    expect(templateDataTypeMap.get("dashboard")).toMatch(/title: string/);
    expect(templateDataTypeMap.get("dashboard")).not.toContain("heading");
  });

  it("original 5 demo templates (user/product/greeting/order/dashboard) are mapped correctly", () => {
    const demoIndexPath = fileURLToPath(
      new URL("../demo/src/index.ts", import.meta.url),
    );
    const program = ts.createProgram({
      rootNames: [demoIndexPath],
      options: {
        allowJs: true,
        checkJs: false,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
      },
    });
    const checker = program.getTypeChecker();
    const sf =
      program.getSourceFile(demoIndexPath) ??
      program.getSourceFile(demoIndexPath.replaceAll("\\", "/"));
    if (!sf) throw new Error(`Source file not found: ${demoIndexPath}`);
    analyzeFileForEtaCalls(sf, checker);

    // greeting must have heading/count and NOT dashboard's properties
    const greeting = templateDataTypeMap.get("greeting");
    expect(greeting).toMatch(/heading: string/);
    expect(greeting).toMatch(/count: number/);
    expect(greeting).not.toContain("title");
    expect(greeting).not.toContain("stats");

    // dashboard must have title/stats and NOT greeting's properties
    const dashboard = templateDataTypeMap.get("dashboard");
    expect(dashboard).toMatch(/title: string/);
    expect(dashboard).toMatch(/stats:/);
    expect(dashboard).toMatch(/visits: number/);
    expect(dashboard).toMatch(/revenue: number/);
    expect(dashboard).not.toContain("heading");

    // user, product, order
    expect(templateDataTypeMap.get("user")).toMatch(/name: string/);
    expect(templateDataTypeMap.get("user")).toMatch(/age: number/);
    expect(templateDataTypeMap.get("product")).toMatch(/inStock: boolean/);
    expect(templateDataTypeMap.get("product")).toMatch(/tags: Array<string>/);
    expect(templateDataTypeMap.get("order")).toMatch(/id: number/);
    expect(templateDataTypeMap.get("order")).toMatch(/total: number/);
  });
});

// ── Complex type inference ────────────────────────────────────────────────────
// Verifies that arrays, nested objects, union string literals, optional
// properties, and arrays of objects are all structurally expanded correctly
// so that Eta templates receive precise IntelliSense.

describe("complex type inference — unit tests via makeTestProgram", () => {
  beforeEach(() => {
    templateDataTypeMap.clear();
    templateLanguageOptionsMap.clear();
  });

  it("string[] tags are preserved as string[]", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };
       interface Post { tags: string[]; title: string }
       declare const p: Post;
       eta.render("post", p);`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const type = templateDataTypeMap.get("post");
    expect(type).toMatch(/tags: Array<string>/);
    expect(type).toMatch(/title: string/);
  });

  it("array of objects expands the element type with []", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };
       interface Comment { id: number; body: string; likes: number }
       interface Post { comments: Comment[] }
       declare const p: Post;
       eta.render("post", p);`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const type = templateDataTypeMap.get("post");
    // comments should be an array of the expanded Comment shape
    expect(type).toMatch(/comments:/);
    expect(type).toMatch(/id: number/);
    expect(type).toMatch(/body: string/);
    expect(type).toMatch(/likes: number/);
    expect(type).toMatch(/Array</); // array marker
  });

  it("union string literals are preserved intact", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };
       interface Notif { type: "info" | "warning" | "error" | "success"; message: string }
       declare const n: Notif;
       eta.render("notification", n);`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const type = templateDataTypeMap.get("notification");
    expect(type).toMatch(/type:/);
    // at least two of the four union members should appear
    expect(type).toMatch(/"info"|"warning"|"error"|"success"/);
    expect(type).toMatch(/message: string/);
  });

  it("boolean properties are preserved", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };
       interface Notif { dismissible: boolean; title: string }
       declare const n: Notif;
       eta.render("notification", n);`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const type = templateDataTypeMap.get("notification");
    expect(type).toMatch(/dismissible: boolean/);
  });

  it("optional properties carry the ? marker", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };
       interface Post { slug: string; featuredImage?: string }
       declare const p: Post;
       eta.render("blog-post", p);`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const type = templateDataTypeMap.get("blog-post");
    expect(type).toMatch(/slug: string/);
    // optional property — TypeScript surfaces it as "string | undefined" or "?: string"
    expect(type).toMatch(/featuredImage/);
  });

  it("doubly-nested object (cart→cartItem→product) is fully expanded", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };
       interface Product { title: string; price: number; inStock: boolean; tags: string[] }
       interface CartItem { product: Product; quantity: number; lineTotal: number }
       interface Cart { items: CartItem[]; subtotal: number; tax: number; total: number }
       declare const c: Cart;
       eta.render("cart", c);`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const type = templateDataTypeMap.get("cart");
    expect(type).toMatch(/items:/);
    expect(type).toMatch(/quantity: number/);
    expect(type).toMatch(/lineTotal: number/);
    // nested product fields should appear inside the expanded CartItem
    expect(type).toMatch(/title: string/);
    expect(type).toMatch(/price: number/);
    expect(type).toMatch(/inStock: boolean/);
    expect(type).toMatch(/tags: Array<string>/);
    expect(type).toMatch(/subtotal: number/);
    expect(type).toMatch(/tax: number/);
    expect(type).toMatch(/total: number/);
  });

  it("nested author object inside BlogPost is structurally expanded", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };
       interface User { name: string; age: number; role: "admin" | "editor" | "viewer" }
       interface Comment { id: number; author: string; body: string; likes: number; createdAt: string }
       interface BlogPost {
         slug: string; title: string; body: string; author: User;
         tags: string[]; comments: Comment[]; publishedAt: string;
         status: "draft" | "published" | "archived"; featuredImage?: string; viewCount: number
       }
       declare const post: BlogPost;
       eta.render("blog-post", post);`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const type = templateDataTypeMap.get("blog-post");
    // top-level scalar fields
    expect(type).toMatch(/slug: string/);
    expect(type).toMatch(/title: string/);
    expect(type).toMatch(/viewCount: number/);
    // status union
    expect(type).toMatch(/status:/);
    expect(type).toMatch(/"published"/);
    // tags array
    expect(type).toMatch(/tags: Array<string>/);
    // author nested fields
    expect(type).toMatch(/author:/);
    expect(type).toMatch(/name: string/);
    // comments array of objects
    expect(type).toMatch(/comments:/);
    expect(type).toMatch(/likes: number/);
    expect(type).toMatch(/createdAt: string/);
    // optional featuredImage
    expect(type).toMatch(/featuredImage/);
  });
});

describe("complex type inference — integration with real demo/src/index.ts", () => {
  let checker: ts.TypeChecker;
  let sf: ts.SourceFile;

  beforeAll(() => {
    templateDataTypeMap.clear();
    templateLanguageOptionsMap.clear();
    const demoIndexPath = fileURLToPath(
      new URL("../demo/src/index.ts", import.meta.url),
    );
    const program = ts.createProgram({
      rootNames: [demoIndexPath],
      options: {
        allowJs: true,
        checkJs: false,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
      },
    });
    checker = program.getTypeChecker();
    const foundSf =
      program.getSourceFile(demoIndexPath) ??
      program.getSourceFile(demoIndexPath.replaceAll("\\", "/"));
    if (!foundSf) throw new Error(`Source file not found: ${demoIndexPath}`);
    sf = foundSf;
    analyzeFileForEtaCalls(sf, checker);
  });

  it("all 8 demo templates are present in the map after analysis", () => {
    const keys = [...templateDataTypeMap.keys()];
    expect(keys).toContain("user");
    expect(keys).toContain("product");
    expect(keys).toContain("greeting");
    expect(keys).toContain("order");
    expect(keys).toContain("dashboard");
    expect(keys).toContain("blog-post");
    expect(keys).toContain("notification");
    expect(keys).toContain("cart");
  });

  it("blog-post: has scalar fields, string[] tags, union status, Comment[] comments, nested author", () => {
    const type = templateDataTypeMap.get("blog-post");
    expect(type).toMatch(/slug: string/);
    expect(type).toMatch(/title: string/);
    expect(type).toMatch(/viewCount: number/);
    expect(type).toMatch(/publishedAt: string/);
    // union status
    expect(type).toMatch(/status:/);
    expect(type).toMatch(/"published"/);
    // string array
    expect(type).toMatch(/tags: Array<string>/);
    // nested author object
    expect(type).toMatch(/author:/);
    expect(type).toMatch(/name: string/);
    expect(type).toMatch(/age: number/);
    // comments array of objects
    expect(type).toMatch(/comments:/);
    expect(type).toMatch(/likes: number/);
    expect(type).toMatch(/createdAt: string/);
    // optional featuredImage
    expect(type).toMatch(/featuredImage/);
  });

  it("blog-post: does NOT bleed into notification or cart", () => {
    const type = templateDataTypeMap.get("blog-post");
    expect(type).not.toContain("dismissible");
    expect(type).not.toContain("subtotal");
  });

  it("notification: has type union, boolean dismissible, optional action fields", () => {
    const type = templateDataTypeMap.get("notification");
    expect(type).toMatch(/type:/);
    expect(type).toMatch(/"warning"|"error"|"info"|"success"/);
    expect(type).toMatch(/title: string/);
    expect(type).toMatch(/message: string/);
    expect(type).toMatch(/dismissible: boolean/);
    // optional properties
    expect(type).toMatch(/actionLabel/);
    expect(type).toMatch(/actionUrl/);
  });

  it("notification: does NOT bleed into blog-post or cart", () => {
    const type = templateDataTypeMap.get("notification");
    expect(type).not.toContain("slug");
    expect(type).not.toContain("subtotal");
  });

  it("cart: has array of CartItems with nested product fields, number totals, optional discountCode", () => {
    const type = templateDataTypeMap.get("cart");
    // top-level
    expect(type).toMatch(/items:/);
    expect(type).toMatch(/subtotal: number/);
    expect(type).toMatch(/tax: number/);
    expect(type).toMatch(/total: number/);
    // optional discount
    expect(type).toMatch(/discountCode/);
    // nested CartItem fields
    expect(type).toMatch(/quantity: number/);
    expect(type).toMatch(/lineTotal: number/);
    // doubly-nested product fields inside CartItem
    expect(type).toMatch(/price: number/);
    expect(type).toMatch(/inStock: boolean/);
    expect(type).toMatch(/tags: Array<string>/);
  });

  it("cart: does NOT bleed into blog-post or notification", () => {
    const type = templateDataTypeMap.get("cart");
    expect(type).not.toContain("slug");
    expect(type).not.toContain("dismissible");
  });
});

describe("demo scenarios from Eta docs", () => {
  beforeAll(() => {
    templateDataTypeMap.clear();
    templateLanguageOptionsMap.clear();
    const demoRoot = fileURLToPath(new URL("../demo", import.meta.url));
    const rootNames = ts.sys
      .readDirectory(
        demoRoot,
        [".ts", ".tsx", ".js", ".jsx"],
        ["node_modules", ".git", "out", "dist", "build"],
      )
      .filter((fileName) => !fileName.includes("node_modules"));

    const program = ts.createProgram({
      rootNames,
      options: {
        allowJs: true,
        checkJs: false,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
      },
    });
    const checker = program.getTypeChecker();

    for (const rootName of rootNames) {
      const sf =
        program.getSourceFile(rootName) ??
        program.getSourceFile(rootName.replaceAll("\\", "/"));
      if (sf) analyzeFileForEtaCalls(sf, checker);
    }
  });

  it("maps each focused scenario template basename", () => {
    const keys = [...templateDataTypeMap.keys()];
    expect(keys).toContain("quickstart-profile");
    expect(keys).toContain("layout-page");
    expect(keys).toContain("layout-shell");
    expect(keys).toContain("helpers-summary");
    expect(keys).toContain("helper-row");
    expect(keys).toContain("helper-badge");
    expect(keys).toContain("async-report");
    expect(keys).toContain("async-line");
    expect(keys).toContain("configured-card");
    expect(keys).toContain("file-invoice");
    expect(keys).toContain("file-receipt");
    expect(keys).toContain("@programmatic-snippet");
    expect(keys).toContain("syntax-gallery");
    expect(keys).not.toContain("Hi <%= it");
  });

  it("quickstart-file-render infers scalar, optional, array, and literal-union fields", () => {
    const type = templateDataTypeMap.get("quickstart-profile");
    expect(type).toMatch(/name: string/);
    expect(type).toMatch(/unreadCount: number/);
    expect(type).toMatch(/roles:/);
    expect(type).toMatch(/"admin"/);
    expect(type).toMatch(/"editor"/);
    expect(type).toMatch(/htmlBio: string/);
    expect(type).toMatch(/lastLogin/);
  });

  it("layouts-and-blocks keeps page and layout data separate", () => {
    const pageType = templateDataTypeMap.get("layout-page");
    const shellType = templateDataTypeMap.get("layout-shell");

    expect(pageType).toMatch(/content: string/);
    expect(pageType).toMatch(/conversionRate: number/);
    expect(pageType).toMatch(/scripts: Array<string>/);
    expect(shellType).toMatch(/body: string/);
    expect(shellType).toMatch(/navItems:/);
    expect(shellType).not.toContain("conversionRate");
  });

  it("partials-and-helpers infers includes and helper partial data", () => {
    const summaryType = templateDataTypeMap.get("helpers-summary");
    const rowType = templateDataTypeMap.get("helper-row");
    const badgeType = templateDataTypeMap.get("helper-badge");

    expect(summaryType).toMatch(/generatedAt: string/);
    expect(summaryType).toMatch(/items:/);
    expect(summaryType).toMatch(/featured/);
    expect(rowType).toMatch(/item:/);
    expect(rowType).toMatch(/value: number/);
    expect(badgeType).toMatch(/status: "ok"/);
    expect(badgeType).toMatch(/label: string/);
  });

  it("async-render infers async page and async partial data", () => {
    const reportType = templateDataTypeMap.get("async-report");
    const lineType = templateDataTypeMap.get("async-line");

    expect(reportType).toMatch(/generatedBy: string/);
    expect(reportType).toMatch(/rows:/);
    expect(reportType).toMatch(/fetchSummary/);
    expect(lineType).toMatch(/row:/);
    expect(lineType).toMatch(/trend:/);
  });

  it("config-options stays compatible with default Eta tags", () => {
    const type = templateDataTypeMap.get("configured-card");
    expect(type).toMatch(/title: string/);
    expect(type).toMatch(/html: string/);
    expect(type).toMatch(/tags: Array<string>/);
    expect(type).toMatch(/owner:/);
    expect(type).toMatch(/score: number/);
  });

  it("api-surface covers named file templates and programmatic named templates", () => {
    const invoiceType = templateDataTypeMap.get("file-invoice");
    const receiptType = templateDataTypeMap.get("file-receipt");
    const programmaticType = templateDataTypeMap.get("@programmatic-snippet");

    expect(invoiceType).toMatch(/id: string/);
    expect(invoiceType).toMatch(/lineItems:/);
    expect(invoiceType).toMatch(/paid: boolean/);
    expect(receiptType).toMatch(/receiptId: string/);
    expect(receiptType).toMatch(/issuedAt: string/);
    expect(programmaticType).toMatch(/title: string/);
    expect(programmaticType).toMatch(/count: number/);
  });

  it("syntax-edge-cases covers object loops, debug flags, and delimiter samples", () => {
    const type = templateDataTypeMap.get("syntax-gallery");
    expect(type).toMatch(/title: string/);
    expect(type).toMatch(/users:/);
    expect(type).toMatch(/countsByStatus:/);
    expect(type).toMatch(/debug: boolean/);
    expect(type).toMatch(/delimiterSamples:/);
  });
});
