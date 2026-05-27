import { describe, it, expect } from "vitest";
import {
  consumeTagContent,
  consumeTagOpener,
  findEtaTagRanges,
} from "../src/etaScanner";

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
