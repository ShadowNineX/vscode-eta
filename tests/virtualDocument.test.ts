import { describe, it, expect } from "vitest";
import {
  DEFAULT_IT_TYPE,
  PREAMBLE_LINE_COUNT,
  buildPreamble,
  buildVirtualContent,
  buildVirtualLine,
} from "../src/virtualDocument";

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
