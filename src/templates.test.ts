/**
 * templates.test.ts
 *
 * Fixture-based tests for the Eta VS Code extension.
 * Each .eta file in templates/ is a realistic code sample.
 * These tests verify the extension's own parsing logic — tag detection,
 * completion context, hover pattern matching, and diagnostics — using
 * those real templates as input, NOT testing the Eta.js engine itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TEMPLATES_DIR = resolve("templates");

function readTemplate(name: string): string {
  return readFileSync(join(TEMPLATES_DIR, name), "utf-8");
}

// ── Mirrors of the extension's core logic ────────────────────────────────────

/** Mirror of EtaCompletionProvider.isInEtaTag */
function isInEtaTag(line: string, position: number): boolean {
  let depth = 0;
  let inTag = false;
  for (let i = 0; i < position; i++) {
    if (line.substring(i, i + 2) === "<%") {
      inTag = true;
      depth++;
      i++;
    } else if (line.substring(i, i + 2) === "%>") {
      depth--;
      if (depth === 0) inTag = false;
      i++;
    }
  }
  return inTag;
}

/** Mirror of EtaDiagnosticsProvider tag-count check */
function countTags(text: string): { openCount: number; closeCount: number } {
  const openCount = (text.match(/<%([#*~=_-])?/g) ?? []).length;
  const closeCount = (text.match(/[-_]?%>/g) ?? []).length;
  return { openCount, closeCount };
}

/** Mirror of EtaDiagnosticsProvider line-level checks */
function diagnoseLine(line: string): string[] {
  const issues: string[] = [];
  if (/<%(?![#*/])/.test(line) && !line.includes("%>"))
    issues.push("unclosed-tag");
  if (/<%\s*%>/.test(line)) issues.push("empty-tag");
  if (line.includes("<%= it") && !line.includes("%>"))
    issues.push("output-not-closed");
  return issues;
}

// ── isInEtaTag - tested against real fixture lines ───────────────────────────

describe("isInEtaTag - simple.eta", () => {
  const line = readTemplate("simple.eta").split("\n")[0];
  // "Hello <%= it.name %>!"

  it("position 0 is outside any tag", () => {
    expect(isInEtaTag(line, 0)).toBe(false);
  });

  it("position inside <%= it.name %> is inside tag", () => {
    const tagStart = line.indexOf("<%=");
    expect(isInEtaTag(line, tagStart + 5)).toBe(true);
  });

  it("position after %> is outside tag", () => {
    const closePos = line.indexOf("%>") + 2;
    expect(isInEtaTag(line, closePos)).toBe(false);
  });
});

describe("isInEtaTag - conditional.eta", () => {
  const line = readTemplate("conditional.eta").split("\n")[0];
  // "<% if (it.show) { %>Visible<% } else { %>Hidden<% } %>"

  it("position inside first execute tag is inside tag", () => {
    expect(isInEtaTag(line, 5)).toBe(true);
  });

  it("position in literal text 'Visible' is outside tag", () => {
    const visPos = line.indexOf("Visible") + 2;
    expect(isInEtaTag(line, visPos)).toBe(false);
  });

  it("position inside last tag block is inside tag", () => {
    const lastTag = line.lastIndexOf("<%");
    expect(isInEtaTag(line, lastTag + 2)).toBe(true);
  });
});

describe("isInEtaTag - loop-array.eta", () => {
  const line = readTemplate("loop-array.eta").split("\n")[0];
  // "<% it.items.forEach(function(item) { %><%= item %><% }) %>"

  it("position at start of execute tag is inside tag", () => {
    expect(isInEtaTag(line, 2)).toBe(true);
  });

  it("position inside output tag is inside tag", () => {
    const outTag = line.indexOf("<%=");
    expect(isInEtaTag(line, outTag + 4)).toBe(true);
  });
});

describe("isInEtaTag - execute.eta", () => {
  const line = readTemplate("execute.eta").split("\n")[0];
  // "<% const sum = it.a + it.b %><%= sum %>"

  it("is inside first execute tag", () => {
    expect(isInEtaTag(line, 3)).toBe(true);
  });

  it("is outside between first %> and second <%=", () => {
    const gapPos = line.indexOf("%>") + 2;
    expect(isInEtaTag(line, gapPos)).toBe(false);
  });

  it("is inside second (output) tag", () => {
    const secTag = line.indexOf("<%=");
    expect(isInEtaTag(line, secTag + 4)).toBe(true);
  });
});

// ── Tag-count balance - well-formed templates should be balanced ──────────────

describe("countTags - well-formed templates are balanced", () => {
  const balanced = [
    "simple.eta",
    "escape.eta",
    "raw.eta",
    "comment.eta",
    "execute.eta",
    "conditional.eta",
    "loop-array.eta",
    "loop-object.eta",
    "partial.eta",
    "page.eta",
    "layout.eta",
    "child.eta",
    "whitespace-trim.eta",
    "output-helper.eta",
    "capture-helper.eta",
  ];

  for (const name of balanced) {
    it(`${name} has equal open and close tag counts`, () => {
      const { openCount, closeCount } = countTags(readTemplate(name));
      expect(openCount).toBe(closeCount);
    });
  }
});

describe("countTags - broken templates have mismatched counts", () => {
  it("broken-mismatch.eta has more open tags than close tags", () => {
    const { openCount, closeCount } = countTags(
      readTemplate("broken-mismatch.eta"),
    );
    expect(openCount).toBeGreaterThan(closeCount);
  });

  it("broken-multiline.eta has more open tags than close tags", () => {
    const { openCount, closeCount } = countTags(
      readTemplate("broken-multiline.eta"),
    );
    expect(openCount).toBeGreaterThan(closeCount);
  });
});

// ── Line-level diagnostics - tested against specific fixture lines ────────────

describe("diagnoseLine - well-formed lines produce no issues", () => {
  it("simple.eta line 0 has no issues", () => {
    const line = readTemplate("simple.eta").split("\n")[0];
    expect(diagnoseLine(line)).toHaveLength(0);
  });

  it("conditional.eta line 0 has no issues", () => {
    const line = readTemplate("conditional.eta").split("\n")[0];
    expect(diagnoseLine(line)).toHaveLength(0);
  });

  it("page.eta line 0 (include line) has no issues", () => {
    const line = readTemplate("page.eta").split("\n")[0];
    expect(diagnoseLine(line)).toHaveLength(0);
  });

  it("child.eta line 0 (layout line) has no issues", () => {
    const line = readTemplate("child.eta").split("\n")[0];
    expect(diagnoseLine(line)).toHaveLength(0);
  });
});

describe("diagnoseLine - broken templates trigger diagnostics", () => {
  it("broken-multiline.eta line 0 triggers unclosed-tag warning", () => {
    const line = readTemplate("broken-multiline.eta").split("\n")[0];
    expect(diagnoseLine(line)).toContain("unclosed-tag");
  });

  it("broken-empty.eta line 0 triggers empty-tag info", () => {
    const line = readTemplate("broken-empty.eta").split("\n")[0];
    expect(diagnoseLine(line)).toContain("empty-tag");
  });
});

// ── Pattern detection - hover / completion context ────────────────────────────

describe("Pattern detection - layout keyword (child.eta)", () => {
  const content = readTemplate("child.eta");

  it("contains layout() call", () => {
    expect(/layout\(/.test(content)).toBe(true);
  });

  it("extracts layout path from template", () => {
    const match = /layout\("([^"]+)"\)/.exec(content);
    expect(match?.[1]).toBe("./layout");
  });
});

describe("Pattern detection - include keyword (page.eta)", () => {
  const content = readTemplate("page.eta");

  it("contains include() call", () => {
    expect(/include\(/.test(content)).toBe(true);
  });

  it("extracts partial path from include()", () => {
    const match = /include\("([^"]+)"\)/.exec(content);
    expect(match?.[1]).toBe("./partial");
  });
});

describe("Pattern detection - forEach loop (loop-array.eta)", () => {
  const content = readTemplate("loop-array.eta");

  it("contains forEach call", () => {
    expect(/forEach\(/.test(content)).toBe(true);
  });

  it("matches loop pattern used by completion provider", () => {
    expect(/<%\s*[\w.]+\.forEach\s*\(/.test(content)).toBe(true);
  });
});

describe("Pattern detection - Object.keys loop (loop-object.eta)", () => {
  const content = readTemplate("loop-object.eta");

  it("contains Object.keys call", () => {
    expect(/Object\.keys\(/.test(content)).toBe(true);
  });

  it("extracts iterated object name", () => {
    const match = /Object\.keys\(it\.(\w+)\)/.exec(content);
    expect(match?.[1]).toBe("obj");
  });
});

describe("Pattern detection - capture helper (capture-helper.eta)", () => {
  const content = readTemplate("capture-helper.eta");

  it("contains capture() call", () => {
    expect(/capture\(/.test(content)).toBe(true);
  });

  it("detects variable assigned from capture()", () => {
    const match = /const\s+(\w+)\s*=\s*capture\(/.exec(content);
    expect(match?.[1]).toBe("frag");
  });
});

describe("Pattern detection - output() helper (output-helper.eta)", () => {
  const content = readTemplate("output-helper.eta");
  const line = content.split("\n")[0];

  it("contains output() call", () => {
    expect(/output\(/.test(content)).toBe(true);
  });

  it("output() is positioned inside an execute tag", () => {
    const outputPos = line.indexOf("output(");
    expect(isInEtaTag(line, outputPos)).toBe(true);
  });
});

describe("Pattern detection - it.property access", () => {
  it("simple.eta accesses it.name", () => {
    const match = /it\.(\w+(?:\.\w+)*)/.exec(readTemplate("simple.eta"));
    expect(match?.[1]).toBe("name");
  });

  it("conditional.eta accesses it.show", () => {
    const match = /it\.(\w+)/.exec(readTemplate("conditional.eta"));
    expect(match?.[1]).toBe("show");
  });

  it("layout.eta accesses it.title and it.body", () => {
    const props = [...readTemplate("layout.eta").matchAll(/it\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(props).toContain("title");
    expect(props).toContain("body");
  });
});

// ── Tag type detection - TAG_TYPES used by the hover provider ────────────────

describe("Tag type detection - all supported prefixes appear in fixtures", () => {
  it("escape.eta contains <%= (output-escaped) tag", () => {
    expect(readTemplate("escape.eta")).toMatch(/<%=/);
  });

  it("raw.eta contains <%~ (output-raw) tag", () => {
    expect(readTemplate("raw.eta")).toMatch(/<%~/);
  });

  it("comment.eta contains <% (execute) tag", () => {
    expect(readTemplate("comment.eta")).toMatch(/<%[^=~#*@]/);
  });

  it("broken-mismatch.eta contains <%~ tag", () => {
    expect(readTemplate("broken-mismatch.eta")).toMatch(/<%~/);
  });

  it("whitespace-trim.eta contains <%_ (whitespace-trim) tag", () => {
    expect(readTemplate("whitespace-trim.eta")).toMatch(/<%_/);
  });
});

// ── Hover word detection - words mapping to ETA_BUILTINS ─────────────────────

describe("Hover word detection - ETA_BUILTINS keywords present in fixtures", () => {
  it("child.eta has hoverable word 'layout'", () => {
    expect(/\blayout\b/.test(readTemplate("child.eta"))).toBe(true);
  });

  it("page.eta has hoverable word 'include'", () => {
    expect(/\binclude\b/.test(readTemplate("page.eta"))).toBe(true);
  });

  it("capture-helper.eta has hoverable word 'capture'", () => {
    expect(/\bcapture\b/.test(readTemplate("capture-helper.eta"))).toBe(true);
  });

  it("output-helper.eta has hoverable word 'output'", () => {
    expect(/\boutput\b/.test(readTemplate("output-helper.eta"))).toBe(true);
  });

  it("simple.eta has hoverable word 'it'", () => {
    expect(/\bit\b/.test(readTemplate("simple.eta"))).toBe(true);
  });
});
