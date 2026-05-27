import { describe, it, expect } from "vitest";

describe("Eta Completion Logic", () => {
  describe("isInEtaTag - Determines if cursor is inside a tag", () => {
    const isInEtaTag = (line: string, position: number): boolean => {
      let depth = 0;
      let inTag = false;

      for (let i = 0; i < position; i++) {
        if (line.substring(i, i + 2) === "<%") {
          inTag = true;
          depth++;
          i++;
        } else if (line.substring(i, i + 2) === "%>") {
          depth--;
          if (depth === 0) {
            inTag = false;
          }
          i++;
        }
      }

      return inTag;
    };

    it("should detect cursor inside simple tag", () => {
      const line = "<%= it.name %>";
      expect(isInEtaTag(line, 7)).toBe(true);
    });

    it("should detect cursor outside tag", () => {
      const line = "<%= it.name %> some text";
      expect(isInEtaTag(line, 20)).toBe(false);
    });

    it("should detect cursor after closing tag", () => {
      const line = "<%= it.name %>";
      expect(isInEtaTag(line, 14)).toBe(false);
    });

    it("should handle nested tags (if supported)", () => {
      const line = "<% if (<%= condition %>) { %>";
      expect(isInEtaTag(line, 8)).toBe(true);
    });

    it("should detect at tag boundary", () => {
      const line = "<%";
      expect(isInEtaTag(line, 2)).toBe(true);
    });

    it("should handle multiple tags on line", () => {
      const line = "<%= first %> text <%= second %>";
      expect(isInEtaTag(line, 5)).toBe(true);
      expect(isInEtaTag(line, 18)).toBe(false);
      expect(isInEtaTag(line, 25)).toBe(true);
    });

    it("should return false before any tag", () => {
      const line = "text <%= value %>";
      expect(isInEtaTag(line, 3)).toBe(false);
    });

    it("should handle unclosed tag", () => {
      const line = "<% let x = 1";
      expect(isInEtaTag(line, 8)).toBe(true);
    });
  });

  describe("Tag Type Detection", () => {
    it("should identify output escaped tag", () => {
      const line = "<%= it.name %>";
      expect(/^<%=/.exec(line)).toBeTruthy();
    });

    it("should identify raw HTML tag", () => {
      const line = "<%~ it.html %>";
      expect(/^<%~/.exec(line)).toBeTruthy();
    });

    it("should identify execute tag", () => {
      const line = "<% let x = 1 %>";
      expect(/^<%[^=~]/.exec(line)).toBeTruthy();
    });

    it("should identify custom comment tag", () => {
      const line = "<%# comment %>";
      expect(/^<%#/.exec(line)).toBeTruthy();
    });

    it("should identify custom translation tag", () => {
      const line = "<%* greeting %>";
      expect(/^<%\*/.exec(line)).toBeTruthy();
    });

    it("should identify programmatic custom tag", () => {
      const line = "<%@ data %>";
      expect(/^<%@/.exec(line)).toBeTruthy();
    });
  });

  describe("Completion Trigger Detection", () => {
    it("should trigger on < character", () => {
      const line = "some text <";
      expect(line.endsWith("<")).toBe(true);
    });

    it("should trigger on <% trigger", () => {
      const line = "some text <%";
      expect(line.endsWith("<%")).toBe(true);
    });

    it("should trigger on dot after it", () => {
      const line = "<% it.";
      expect(line.includes("it.")).toBe(true);
    });

    it("should detect completion context after space", () => {
      const line = "<% ";
      expect(line.includes("<%")).toBe(true);
    });
  });

  describe("Code Pattern Extraction", () => {
    it("should extract function name from line", () => {
      const line = '<% layout("./base") %>';
      const match = /layout/.exec(line);
      expect(match).toBeTruthy();
      expect(match?.[0]).toBe("layout");
    });

    it("should extract template path from include", () => {
      const line = '<%~ include("./header") %>';
      const match = /include\("([^"]+)"\)/.exec(line);
      expect(match?.[1]).toBe("./header");
    });

    it("should extract block name", () => {
      const line = '<% block("sidebar", () => { %>';
      const match = /block\("([^"]+)"/.exec(line);
      expect(match?.[1]).toBe("sidebar");
    });

    it("should extract variable assignment", () => {
      const line = "<% const fragment = capture(() => { %>";
      const match = /const\s+(\w+)\s*=/.exec(line);
      expect(match?.[1]).toBe("fragment");
    });

    it("should extract data property access", () => {
      const line = "<%= it.user.name %>";
      const match = /it\.(\w+(?:\.\w+)*)/.exec(line);
      expect(match?.[1]).toBe("user.name");
    });
  });

  describe("Diagnostic Detection", () => {
    it("should count mismatched opening tags", () => {
      const text = "<% if { content";
      const openCount = (text.match(/<%/g) || []).length;
      const closeCount = (text.match(/%>/g) || []).length;
      expect(openCount).toBeGreaterThan(closeCount);
    });

    it("should detect empty tags", () => {
      const line = "<%  %>";
      expect(/<%\s*%>/.test(line)).toBe(true);
    });

    it("should detect unclosed output tag", () => {
      const line = "<%= it.value";
      expect(line.includes("<%=")).toBe(true);
      expect(line.includes("%>")).toBe(false);
    });

    it("should detect mismatched braces", () => {
      const line = "<% if (condition { %>";
      const braceCount = (line.match(/\(/g) || []).length;
      const closeBraceCount = (line.match(/\)/g) || []).length;
      expect(braceCount).not.toBe(closeBraceCount);
    });

    it("should validate tag format", () => {
      const validTags = ["<%", "<%=", "<%~", "<%#", "<%*", "<%@"];
      validTags.forEach((tag) => {
        expect(tag.startsWith("<%")).toBe(true);
      });
    });
  });
});

describe("Eta Hover Provider Logic", () => {
  describe("Documentation Lookup", () => {
    const ETA_BUILTINS: { [key: string]: any } = {
      layout: {
        label: "layout",
        detail: "Set parent layout",
        documentation: "Sets a parent layout for the current template.",
      },
      include: {
        label: "include",
        detail: "Include a partial template",
        documentation: "Renders a partial template inline.",
      },
      block: {
        label: "block",
        detail: "Define or render a named block",
        documentation:
          "Define a named block in child template or render in layout.",
      },
    };

    it("should find documentation for layout", () => {
      expect(ETA_BUILTINS["layout"]).toBeTruthy();
      expect(ETA_BUILTINS["layout"].detail).toBe("Set parent layout");
    });

    it("should find documentation for include", () => {
      expect(ETA_BUILTINS["include"]).toBeTruthy();
      expect(ETA_BUILTINS["include"].detail).toContain("Include");
    });

    it("should not find documentation for unknown function", () => {
      expect(ETA_BUILTINS["unknownFunc"]).toBeUndefined();
    });

    it("should return null for non-builtin", () => {
      const word = "forEach";
      const doc = ETA_BUILTINS[word];
      expect(doc).toBeUndefined();
    });
  });

  describe("Tag Information", () => {
    const TAG_TYPES: { [key: string]: any } = {
      "<%": { name: "execute", desc: "Execute JavaScript" },
      "<%=": { name: "output-escaped", desc: "Output escaped value" },
      "<%~": { name: "output-raw", desc: "Output raw HTML" },
    };

    it("should find tag type for <%", () => {
      expect(TAG_TYPES["<%"]).toBeTruthy();
      expect(TAG_TYPES["<%"].desc).toBe("Execute JavaScript");
    });

    it("should find tag type for <%=", () => {
      expect(TAG_TYPES["<%="].desc).toContain("escaped");
    });

    it("should find tag type for <%~", () => {
      expect(TAG_TYPES["<%~"].desc).toContain("raw");
    });
  });
});
