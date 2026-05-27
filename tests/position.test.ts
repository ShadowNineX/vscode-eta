import { describe, it, expect } from "vitest";
import {
  isInsideEtaTag,
  isInsideEtaTagInText,
  positionToOffset,
} from "../src/position";

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
