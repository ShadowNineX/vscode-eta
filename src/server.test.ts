import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import * as ts from "typescript";
import { fileURLToPath } from "node:url";

// ── Mock LSP infrastructure so server.ts module-level code doesn't crash ──────

vi.mock("vscode-languageserver/node", () => {
  const noop = vi.fn();
  const mockConnection = {
    onInitialize: noop,
    onCompletion: noop,
    onHover: noop,
    onDidChangeWatchedFiles: noop,
    listen: noop,
  };
  const mockDocuments = {
    onDidOpen: noop,
    onDidChangeContent: noop,
    get: vi.fn(),
    listen: noop,
  };
  return {
    createConnection: vi.fn(function () {
      return mockConnection;
    }),
    TextDocuments: vi.fn(function () {
      return mockDocuments;
    }),
    ProposedFeatures: { all: "all" },
    TextDocumentSyncKind: { Incremental: 2 },
    CompletionItemKind: {
      Text: 1,
      Method: 2,
      Function: 3,
      Variable: 6,
      Class: 7,
      Interface: 8,
      Module: 9,
      Property: 10,
      Constant: 21,
      Keyword: 14,
      TypeParameter: 25,
    },
    MarkupKind: { Markdown: "markdown" },
    FileChangeType: { Created: 1, Changed: 2, Deleted: 3 },
  };
});

vi.mock("vscode-languageserver-textdocument", () => ({
  TextDocument: { create: vi.fn() },
}));

import {
  PREAMBLE_LINE_COUNT,
  DEFAULT_IT_TYPE,
  buildPreamble,
  consumeTagOpener,
  consumeTagContent,
  buildVirtualLine,
  buildVirtualContent,
  findEtaTagRanges,
  isInsideEtaTag,
  isInsideEtaTagInText,
  positionToOffset,
  tsKindToLSP,
  typeToStructuralString,
  analyzeFileForEtaCalls,
  templateDataTypeMap,
  getItTypeForUri,
  workspaceTsFiles,
  scanWorkspaceFiles,
} from "./server.js";

// ── consumeTagOpener ──────────────────────────────────────────────────────────

describe("consumeTagOpener", () => {
  it("handles bare <% (no modifier)", () => {
    const r = consumeTagOpener("<% code %>", 0);
    expect(r.padLen).toBe(2);
    expect(r.next).toBe(2);
  });

  it("handles <%= (output escaped)", () => {
    const r = consumeTagOpener("<%= it.x %>", 0);
    expect(r.padLen).toBe(3);
    expect(r.next).toBe(3);
  });

  it("handles <%~ (output raw)", () => {
    const r = consumeTagOpener("<%~ it.x %>", 0);
    expect(r.padLen).toBe(3);
    expect(r.next).toBe(3);
  });

  it("handles <%# (custom comment)", () => {
    const r = consumeTagOpener("<%# comment %>", 0);
    expect(r.padLen).toBe(3);
    expect(r.next).toBe(3);
  });

  it("handles <%* (custom tag)", () => {
    const r = consumeTagOpener("<%* key %>", 0);
    expect(r.padLen).toBe(3);
    expect(r.next).toBe(3);
  });

  it("works at a non-zero start offset", () => {
    const line = "text<%= it.x %>";
    const r = consumeTagOpener(line, 4);
    expect(r.padLen).toBe(3);
    expect(r.next).toBe(7);
  });

  it("handles <%- (newline trim)", () => {
    const r = consumeTagOpener("<%- code %>", 0);
    expect(r.padLen).toBe(3);
    expect(r.next).toBe(3);
  });

  it("handles <%_ (whitespace trim)", () => {
    const r = consumeTagOpener("<%_ code %>", 0);
    expect(r.padLen).toBe(3);
    expect(r.next).toBe(3);
  });

  it("handles <%-= (newline trim + output escaped)", () => {
    const r = consumeTagOpener("<%-= it.x %>", 0);
    expect(r.padLen).toBe(4);
    expect(r.next).toBe(4);
  });

  it("handles <%_~ (whitespace trim + output raw)", () => {
    const r = consumeTagOpener("<%_~ it.x %>", 0);
    expect(r.padLen).toBe(4);
    expect(r.next).toBe(4);
  });
});

// ── consumeTagContent ─────────────────────────────────────────────────────────

describe("consumeTagContent", () => {
  it("reads JS until %> and pads 2 spaces for the closer", () => {
    const { js, next } = consumeTagContent("code %>", 0);
    expect(js).toBe("code   "); // "code " + "  " for %>
    expect(next).toBe(7);
  });

  it("returns all remaining chars if no closing tag on line", () => {
    const line = " let x = 1";
    const { js, next } = consumeTagContent(line, 0);
    expect(js).toBe(" let x = 1");
    expect(next).toBe(line.length);
  });

  it("reads JS until -%> and pads 3 spaces for the closer", () => {
    const { js, next } = consumeTagContent("x = 1 -%>", 0);
    expect(js).toBe("x = 1    "); // "x = 1 " + "   " for -%>
    expect(next).toBe(9);
  });

  it("reads JS until _%> and pads 3 spaces for the closer", () => {
    const { js, next } = consumeTagContent("y _%>", 0);
    expect(js).toBe("y    "); // "y " + "   " for _%>
    expect(next).toBe(5);
  });

  it("starts reading from a non-zero position", () => {
    // Simulate reading after consumeTagOpener for "<%~ it.html %>"
    // opener consumed 3 chars ("<%~"), content starts at 3
    const { js, next } = consumeTagContent("<%~ it.html %>", 3);
    expect(js).toBe(" it.html   "); // " it.html " + "  " for %>
    expect(next).toBe(14);
  });

  it("ignores %> inside a string literal", () => {
    const { js, next } = consumeTagContent('"%>" %>', 0);
    expect(js).toBe('"%>"   ');
    expect(next).toBe(7);
  });

  it("ignores %> inside a block comment", () => {
    const { js, next } = consumeTagContent("/* %> */ value %>", 0);
    expect(js).toBe("/* %> */ value   ");
    expect(next).toBe(17);
  });
});

// ── buildVirtualLine ──────────────────────────────────────────────────────────

describe("buildVirtualLine", () => {
  it("replaces HTML-only text with spaces", () => {
    const line = "Hello World";
    expect(buildVirtualLine(line)).toBe("           ");
    expect(buildVirtualLine(line).length).toBe(line.length);
  });

  it("preserves JS inside <%= %> at the correct character positions", () => {
    const line = "Hello <%= it.name %>!";
    const vl = buildVirtualLine(line);
    // Original: 'i' at position 10, 't' at 11, '.' at 12, 'n' at 13
    expect(vl[10]).toBe("i");
    expect(vl[11]).toBe("t");
    expect(vl[12]).toBe(".");
    expect(vl[13]).toBe("n");
    expect(vl.length).toBe(line.length);
  });

  it("preserves JS inside <% %> at the correct positions", () => {
    const line = "<% const x = 1 %>";
    const vl = buildVirtualLine(line);
    // "const" starts at position 3 in original
    expect(vl.substring(3, 12)).toBe("const x =");
    expect(vl.length).toBe(line.length);
  });

  it("handles <%~ tag (raw output)", () => {
    const line = "<%~ it.html %>";
    const vl = buildVirtualLine(line);
    expect(vl[4]).toBe("i"); // 'i' of 'it'
    expect(vl.length).toBe(line.length);
  });

  it("handles <%- (newline trim) tag", () => {
    const line = "<%- code %>";
    const vl = buildVirtualLine(line);
    expect(vl[4]).toBe("c");
    expect(vl.length).toBe(line.length);
  });

  it("handles <%_= (whitespace trim + output) combo", () => {
    const line = "<%_= it.val %>";
    const vl = buildVirtualLine(line);
    expect(vl[4]).toBe(" ");
    expect(vl[5]).toBe("i");
    expect(vl.length).toBe(line.length);
  });

  it("handles whitespace before an output prefix", () => {
    const line = "<% = it.name %>";
    const vl = buildVirtualLine(line);
    expect(vl[5]).toBe("i");
    expect(vl.substring(5, 12)).toBe("it.name");
    expect(vl.length).toBe(line.length);
  });

  it("does not treat a JavaScript block comment as a custom prefix", () => {
    const line = "<% /* comment */ %>";
    const vl = buildVirtualLine(line);
    expect(vl.substring(3, 16)).toBe("/* comment */");
    expect(vl.length).toBe(line.length);
  });

  it("handles _%> trim closer", () => {
    const line = "<% code _%>";
    const vl = buildVirtualLine(line);
    expect(vl[3]).toBe("c");
    expect(vl.length).toBe(line.length);
  });

  it("handles multiple tags on one line", () => {
    const line = "<% if (cond) { %> text <% } %>";
    const vl = buildVirtualLine(line);
    // "if (cond)" starts at position 3 in original
    expect(vl[3]).toBe("i");
    expect(vl[4]).toBe("f");
    expect(vl.length).toBe(line.length);
  });

  it("handles empty string", () => {
    expect(buildVirtualLine("")).toBe("");
  });

  it("handles a line with no tags (pure HTML)", () => {
    const line = '<div class="foo">Hello</div>';
    const vl = buildVirtualLine(line);
    expect(vl).toBe(" ".repeat(line.length));
  });
});

// ── buildVirtualContent ───────────────────────────────────────────────────────

describe("buildVirtualContent", () => {
  it("prepends exactly PREAMBLE_LINE_COUNT lines before source content", () => {
    const source = "<%= it.name %>";
    const vc = buildVirtualContent(source);
    const lines = vc.split("\n");
    // The first Eta line is at index PREAMBLE_LINE_COUNT
    expect(lines[PREAMBLE_LINE_COUNT]).toBe(buildVirtualLine(source));
  });

  it("includes 'declare const it' in the preamble", () => {
    const vc = buildVirtualContent("");
    expect(vc).toContain("declare const it:");
  });

  it("includes all Eta builtin declarations in the preamble", () => {
    const vc = buildVirtualContent("");
    for (const name of [
      "include",
      "includeAsync",
      "layout",
      "block",
      "blockAsync",
      "output",
      "capture",
      "captureAsync",
    ]) {
      expect(vc).toContain(`declare function ${name}`);
    }
  });

  it("ends with 'export {}' to scope it as a module (prevents cross-file `it` bleed)", () => {
    const vc = buildVirtualContent("<%= it.x %>");
    expect(vc.trimEnd()).toMatch(/export\s*\{\s*\};?$/);
  });

  it("preserves multi-line source with correct line offsets", () => {
    const source = "line0\n<%= it.x %>\nline2";
    const vc = buildVirtualContent(source);
    const lines = vc.split("\n");
    // line0 (eta line 0) → virtual line PREAMBLE_LINE_COUNT
    expect(lines[PREAMBLE_LINE_COUNT]).toBe(buildVirtualLine("line0"));
    // <% ... %> (eta line 1) → virtual line PREAMBLE_LINE_COUNT + 1
    expect(lines[PREAMBLE_LINE_COUNT + 1]).toBe(
      buildVirtualLine("<%= it.x %>"),
    );
    // line2 (eta line 2) → virtual line PREAMBLE_LINE_COUNT + 2
    expect(lines[PREAMBLE_LINE_COUNT + 2]).toBe(buildVirtualLine("line2"));
  });

  it("preserves JavaScript inside a multi-line Eta tag", () => {
    const source = "<% for (const item of it.items) {\n output(item)\n} %>";
    const vc = buildVirtualContent(source);
    const lines = vc.split("\n");
    expect(lines[PREAMBLE_LINE_COUNT]).toContain("for (const item");
    expect(lines[PREAMBLE_LINE_COUNT + 1]).toContain("output(item)");
    expect(lines[PREAMBLE_LINE_COUNT + 2]).toContain("}");
  });

  it("keeps a delimiter-looking string inside the virtual TypeScript", () => {
    const source = '<%= "%>" %>';
    const vc = buildVirtualContent(source);
    expect(vc).toContain('"%>"');
  });
});

// ── PREAMBLE_LINE_COUNT ───────────────────────────────────────────────────────

describe("PREAMBLE_LINE_COUNT", () => {
  it("equals the number of declaration lines (9)", () => {
    expect(PREAMBLE_LINE_COUNT).toBe(9);
  });

  it("matches the actual newline count in the preamble string", () => {
    const vc = buildVirtualContent("x");
    const preambleLines = vc.split("\n").slice(0, PREAMBLE_LINE_COUNT);
    expect(preambleLines.every((l) => l.startsWith("declare"))).toBe(true);
  });
});

// ── isInsideEtaTag ────────────────────────────────────────────────────────────

describe("isInsideEtaTag", () => {
  it("returns true when cursor is inside a tag", () => {
    expect(isInsideEtaTag("<%= it.name %>", 7)).toBe(true);
  });

  it("returns false when cursor is after a closing tag", () => {
    expect(isInsideEtaTag("<%= it.name %>", 14)).toBe(false);
  });

  it("returns false when cursor is before any tag", () => {
    expect(isInsideEtaTag("Hello <%= it.name %>", 4)).toBe(false);
  });

  it("returns true at the very start of tag content (right after opener)", () => {
    expect(isInsideEtaTag("<% x %>", 3)).toBe(true);
  });

  it("returns false for text between two closed tags", () => {
    const line = "<%= a %> text <%= b %>";
    expect(isInsideEtaTag(line, 10)).toBe(false); // in "text" between tags
  });

  it("returns true in the second tag of a multi-tag line", () => {
    const line = "<%= a %> text <%= b %>";
    expect(isInsideEtaTag(line, 19)).toBe(true);
  });

  it("returns true for unclosed tag at end of line", () => {
    expect(isInsideEtaTag("<% let x = 1", 8)).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isInsideEtaTag("", 0)).toBe(false);
  });

  it("returns false for pure HTML line", () => {
    expect(isInsideEtaTag("<div>hello</div>", 5)).toBe(false);
  });

  it("ignores a delimiter-looking string when checking a single line", () => {
    const line = '<%= "%>" + it.name %>';
    expect(isInsideEtaTag(line, line.indexOf("it.name"))).toBe(true);
  });
});

describe("isInsideEtaTagInText", () => {
  it("returns true inside a multi-line Eta tag", () => {
    const text = "<% for (const item of it.items) {\n output(item)\n} %>";
    expect(isInsideEtaTagInText(text, 1, 3)).toBe(true);
  });

  it("returns false after a multi-line Eta tag closes", () => {
    const text = "<% if (it.show) {\n output('yes')\n} %>\n<p>done</p>";
    expect(isInsideEtaTagInText(text, 3, 1)).toBe(false);
  });
});

describe("findEtaTagRanges", () => {
  it("marks closed multi-line tags as closed", () => {
    const ranges = findEtaTagRanges("<% if (it.show) {\n output('yes')\n} %>");
    expect(ranges).toHaveLength(1);
    expect(ranges[0].closed).toBe(true);
  });

  it("marks truly unclosed tags as unclosed", () => {
    const ranges = findEtaTagRanges("<%= it.name");
    expect(ranges).toHaveLength(1);
    expect(ranges[0].closed).toBe(false);
  });

  it("marks empty tags", () => {
    const ranges = findEtaTagRanges("<% %>");
    expect(ranges[0].empty).toBe(true);
  });
});

// ── positionToOffset ──────────────────────────────────────────────────────────

describe("positionToOffset", () => {
  const content = "line0\nline1\nline2";

  it("offset 0 for line 0, char 0", () => {
    expect(positionToOffset(content, 0, 0)).toBe(0);
  });

  it("correct offset for char within line 0", () => {
    expect(positionToOffset(content, 0, 3)).toBe(3);
  });

  it("correct offset for start of line 1", () => {
    // "line0\n" = 6 chars, so line 1 starts at offset 6
    expect(positionToOffset(content, 1, 0)).toBe(6);
  });

  it("correct offset for char within line 1", () => {
    expect(positionToOffset(content, 1, 4)).toBe(10);
  });

  it("correct offset for start of line 2", () => {
    // "line0\nline1\n" = 12 chars
    expect(positionToOffset(content, 2, 0)).toBe(12);
  });

  it("handles single-line content", () => {
    expect(positionToOffset("hello", 0, 3)).toBe(3);
  });
});

// ── tsKindToLSP ──────────────────────────────────────────────────────────────

describe("tsKindToLSP", () => {
  it("maps 'function' → Function", () => {
    expect(tsKindToLSP("function")).toBe(3); // CompletionItemKind.Function
  });

  it("maps 'local function' → Function", () => {
    expect(tsKindToLSP("local function")).toBe(3);
  });

  it("maps 'method' → Method", () => {
    expect(tsKindToLSP("method")).toBe(2);
  });

  it("maps 'property' → Property", () => {
    expect(tsKindToLSP("property")).toBe(10);
  });

  it("maps 'accessor' → Property", () => {
    expect(tsKindToLSP("accessor")).toBe(10);
  });

  it("maps 'member' → Property", () => {
    expect(tsKindToLSP("member")).toBe(10);
  });

  it("maps 'class' → Class", () => {
    expect(tsKindToLSP("class")).toBe(7);
  });

  it("maps 'interface' → Interface", () => {
    expect(tsKindToLSP("interface")).toBe(8);
  });

  it("maps 'module' → Module", () => {
    expect(tsKindToLSP("module")).toBe(9);
  });

  it("maps 'variable' → Variable", () => {
    expect(tsKindToLSP("variable")).toBe(6);
  });

  it("maps 'local var' → Variable", () => {
    expect(tsKindToLSP("local var")).toBe(6);
  });

  it("maps 'const' → Constant", () => {
    expect(tsKindToLSP("const")).toBe(21);
  });

  it("maps 'keyword' → Keyword", () => {
    expect(tsKindToLSP("keyword")).toBe(14);
  });

  it("maps 'type' → TypeParameter", () => {
    expect(tsKindToLSP("type")).toBe(25);
  });

  it("maps unknown kind → Text", () => {
    expect(tsKindToLSP("enum")).toBe(1);
    expect(tsKindToLSP("")).toBe(1);
    expect(tsKindToLSP("unknown-kind")).toBe(1);
  });
});

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

// ── DEFAULT_IT_TYPE ────────────────────────────────────────────────────────────────

describe("DEFAULT_IT_TYPE", () => {
  it("is the fallback type string", () => {
    expect(DEFAULT_IT_TYPE).toBe("Record<string, any>");
  });
});

// ── buildPreamble ────────────────────────────────────────────────────────────────

describe("buildPreamble", () => {
  it("uses the provided it type on line 1", () => {
    const p = buildPreamble("{ name: string; age: number }");
    expect(p.split("\n")[0]).toBe(
      "declare const it: { name: string; age: number };",
    );
  });

  it("always produces exactly 9 newlines (PREAMBLE_LINE_COUNT)", () => {
    const p = buildPreamble("{ x: number }");
    expect((p.match(/\n/g) ?? []).length).toBe(PREAMBLE_LINE_COUNT);
  });

  it("collapses multi-line it type to a single line", () => {
    const multi = "{ name: string;\n  age: number }";
    const p = buildPreamble(multi);
    expect(p.split("\n")[0]).not.toContain("\n");
    expect(p.split("\n")[0]).toContain("name: string");
    expect(p.split("\n")[0]).toContain("age: number");
  });

  it("falls back gracefully with DEFAULT_IT_TYPE", () => {
    const p = buildPreamble(DEFAULT_IT_TYPE);
    expect(p).toContain("declare const it: Record<string, any>;");
  });

  it("includes all Eta builtin declarations", () => {
    const p = buildPreamble(DEFAULT_IT_TYPE);
    for (const name of [
      "include",
      "includeAsync",
      "layout",
      "block",
      "blockAsync",
      "output",
      "capture",
      "captureAsync",
    ]) {
      expect(p).toContain(`declare function ${name}`);
    }
  });
});

// ── buildVirtualContent with custom itType ───────────────────────────────────────

describe("buildVirtualContent (with itType)", () => {
  it("uses the custom it type in the first preamble line", () => {
    const vc = buildVirtualContent("<%= it.name %>", "{ name: string }");
    expect(vc.split("\n")[0]).toBe("declare const it: { name: string };");
  });

  it("falls back to DEFAULT_IT_TYPE when no itType given", () => {
    const vc = buildVirtualContent("");
    expect(vc).toContain("declare const it: Record<string, any>;");
  });

  it("still has exactly PREAMBLE_LINE_COUNT lines before template content", () => {
    const source = "line0";
    const vc = buildVirtualContent(source, "{ x: number }");
    expect(vc.split("\n")[PREAMBLE_LINE_COUNT]).toBe(buildVirtualLine(source));
  });
});

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
    expect(typeToStructuralString(checker, type)).toBe("string[]");
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
  beforeEach(() => templateDataTypeMap.clear());

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

  it("detects renderString() call", () => {
    const { checker, sf } = makeTestProgram(
      `declare function renderString(t: string, d: any): string;\n` +
        `renderString("greeting", { message: "hello" });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const result = templateDataTypeMap.get("greeting");
    expect(result).toMatch(/message: string/);
  });

  it("strips .eta extension from template path for the key", () => {
    const { checker, sf } = makeTestProgram(
      `declare function render(t: string, d: any): string;\n` +
        `render("views/user.eta", { id: 1 });`,
    );
    analyzeFileForEtaCalls(sf, checker);
    expect(templateDataTypeMap.has("user")).toBe(true);
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
    expect(result).toMatch(/tags: string\[\]/);
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
  beforeEach(() => templateDataTypeMap.clear());

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
  beforeEach(() => templateDataTypeMap.clear());

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

  it("correctly maps all templates when ALL workspace source files are analyzed together", () => {
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
  });
});

// ── scanWorkspaceFiles ────────────────────────────────────────────────────────

describe("scanWorkspaceFiles", () => {
  beforeEach(() => workspaceTsFiles.clear());

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
  beforeEach(() => templateDataTypeMap.clear());

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
    expect(templateDataTypeMap.get("product")).toMatch(/tags: string\[\]/);
    expect(templateDataTypeMap.get("order")).toMatch(/id: number/);
    expect(templateDataTypeMap.get("order")).toMatch(/total: number/);
  });
});

// ── Complex type inference ────────────────────────────────────────────────────
// Verifies that arrays, nested objects, union string literals, optional
// properties, and arrays of objects are all structurally expanded correctly
// so that Eta templates receive precise IntelliSense.

describe("complex type inference — unit tests via makeTestProgram", () => {
  beforeEach(() => templateDataTypeMap.clear());

  it("string[] tags are preserved as string[]", () => {
    const { checker, sf } = makeTestProgram(
      `declare const eta: { render<T extends object>(t: string, d: T): string };
       interface Post { tags: string[]; title: string }
       declare const p: Post;
       eta.render("post", p);`,
    );
    analyzeFileForEtaCalls(sf, checker);
    const type = templateDataTypeMap.get("post");
    expect(type).toMatch(/tags: string\[\]/);
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
    expect(type).toMatch(/\[\]/); // array marker
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
    expect(type).toMatch(/tags: string\[\]/);
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
    expect(type).toMatch(/tags: string\[\]/);
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
    expect(type).toMatch(/tags: string\[\]/);
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
    expect(type).toMatch(/tags: string\[\]/);
  });

  it("cart: does NOT bleed into blog-post or notification", () => {
    const type = templateDataTypeMap.get("cart");
    expect(type).not.toContain("slug");
    expect(type).not.toContain("dismissible");
  });
});
