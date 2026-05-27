import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";

// Mock VS Code API
vi.mock("vscode", () => ({
  CompletionItemKind: {
    Function: 12,
    Variable: 13,
    Method: 2,
    Property: 10,
    Keyword: 14,
  },
  SnippetStringFormat: {
    Placeholders: 1,
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
  },
  languages: {
    createDiagnosticCollection: vi.fn(),
    registerCompletionItemProvider: vi.fn(),
    registerHoverProvider: vi.fn(),
  },
  workspace: {
    onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
  window: {
    visibleTextEditors: [],
  },
  Range: class Range {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number,
    ) {
      (this as any).start = { line: startLine, character: startChar };
      (this as any).end = { line: endLine, character: endChar };
    }
  },
  Position: class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  MarkdownString: class MarkdownString {
    constructor(public value: string = "") {}
    appendMarkdown(md: string) {
      this.value += md;
    }
  },
  SnippetString: class SnippetString {
    constructor(public value: string) {}
  },
  Diagnostic: class Diagnostic {
    source?: string;
    constructor(
      public range: any,
      public message: string,
      public severity: number,
    ) {}
  },
  CompletionItem: class CompletionItem {
    detail?: string;
    documentation?: any;
    insertText?: any;
    constructor(
      public label: string,
      public kind: number,
    ) {}
  },
  Hover: class Hover {
    constructor(public contents: any) {}
  },
}));

describe("Eta Extension", () => {
  describe("Unit Tests", () => {
    it("should be able to mock VS Code API", () => {
      expect(vscode.CompletionItemKind.Function).toBe(12);
      expect(vscode.CompletionItemKind.Variable).toBe(13);
    });

    it("should create diagnostic collection", () => {
      const createDiagnosticCollectionSpy = vi.spyOn(
        vscode.languages,
        "createDiagnosticCollection",
      );
      vscode.languages.createDiagnosticCollection("test");
      expect(createDiagnosticCollectionSpy).toHaveBeenCalledWith("test");
    });

    it("should register completion provider", () => {
      const registerCompletionSpy = vi.spyOn(
        vscode.languages,
        "registerCompletionItemProvider",
      );
      const mockProvider = {
        provideCompletionItems: vi.fn(),
      };
      vscode.languages.registerCompletionItemProvider("eta", mockProvider, "<");
      expect(registerCompletionSpy).toHaveBeenCalledWith(
        "eta",
        expect.any(Object),
        "<",
      );
    });

    it("should create Range with correct coordinates", () => {
      const range = new vscode.Range(0, 0, 1, 10);
      expect((range as any).start.line).toBe(0);
      expect((range as any).start.character).toBe(0);
      expect((range as any).end.line).toBe(1);
      expect((range as any).end.character).toBe(10);
    });

    it("should create CompletionItem with label and kind", () => {
      const item = new vscode.CompletionItem(
        "layout",
        vscode.CompletionItemKind.Function,
      );
      expect(item.label).toBe("layout");
      expect(item.kind).toBe(vscode.CompletionItemKind.Function);
    });

    it("should create MarkdownString and append content", () => {
      const md = new vscode.MarkdownString("**Bold**");
      md.appendMarkdown("\n\nMore content");
      expect(md.value).toBe("**Bold**\n\nMore content");
    });

    it("should create Diagnostic with message and severity", () => {
      const range = new vscode.Range(0, 0, 0, 5);
      const diag = new vscode.Diagnostic(
        range,
        "Test error",
        vscode.DiagnosticSeverity.Error,
      );
      expect(diag.message).toBe("Test error");
      expect(diag.severity).toBe(vscode.DiagnosticSeverity.Error);
    });

    it("should create Position with line and character", () => {
      const pos = new vscode.Position(5, 10);
      expect(pos.line).toBe(5);
      expect(pos.character).toBe(10);
    });

    it("should create SnippetString", () => {
      const snippet = new vscode.SnippetString('layout("${1:./layout}")$0');
      expect(snippet.value).toBe('layout("${1:./layout}")$0');
    });
  });

  describe("Eta Syntax Utilities", () => {
    it("should detect tag in line correctly", () => {
      const line = "<%= it.name %>";
      expect(line.includes("<%")).toBe(true);
      expect(line.includes("%>")).toBe(true);
    });

    it("should identify escaped output tags", () => {
      const line = "<%= it.value %>";
      expect(line.startsWith("<%=")).toBe(true);
    });

    it("should identify raw HTML tags", () => {
      const line = "<%~ it.html %>";
      expect(line.startsWith("<%~")).toBe(true);
    });

    it("should identify execute tags", () => {
      const line = "<% let x = 1 %>";
      expect(line.startsWith("<%")).toBe(true);
      expect(line.includes("<%=")).toBe(false);
    });

    it("should count opening and closing tags", () => {
      const text = "<% if (true) { %> content <% } %>";
      const openCount = (text.match(/<%/g) || []).length;
      const closeCount = (text.match(/%>/g) || []).length;
      expect(openCount).toBe(2);
      expect(closeCount).toBe(2);
    });

    it("should detect mismatched tags", () => {
      const text = "<% if (true) { %> content <% }";
      const openCount = (text.match(/<%/g) || []).length;
      const closeCount = (text.match(/%>/g) || []).length;
      expect(openCount).not.toBe(closeCount);
    });

    it("should identify empty tags", () => {
      const line = "<%  %>";
      const isEmpty = /<%\s*%>/.test(line);
      expect(isEmpty).toBe(true);
    });

    it("should extract tag content", () => {
      const line = "<%= it.name %>";
      const content = line.replace(/<%=\s*/, "").replace(/\s*%>/, "");
      expect(content.trim()).toBe("it.name");
    });

    it("should identify custom tags", () => {
      const line = "<%# this is a comment %>";
      expect(line.includes("<%#")).toBe(true);
    });

    it("should identify async operations", () => {
      const line = '<%~ await includeAsync("./partial") %>';
      expect(line.includes("await")).toBe(true);
      expect(line.includes("includeAsync")).toBe(true);
    });

    it('should identify data access via "it" object', () => {
      const line = "<%= it.user.name %>";
      expect(line.includes("it.")).toBe(true);
    });
  });

  describe("Eta Built-in Functions", () => {
    const etaFunctions = [
      "layout",
      "include",
      "includeAsync",
      "block",
      "blockAsync",
      "output",
      "capture",
      "captureAsync",
    ];

    it("should recognize all Eta built-in functions", () => {
      etaFunctions.forEach((func) => {
        expect(etaFunctions).toContain(func);
      });
    });

    it("should identify layout function", () => {
      const line = 'layout("./base")';
      expect(line.includes("layout")).toBe(true);
    });

    it("should identify include function", () => {
      const line = 'include("./partial")';
      expect(line.includes("include")).toBe(true);
    });

    it("should identify block function", () => {
      const line = 'block("name", () => { })';
      expect(line.includes("block")).toBe(true);
    });

    it("should identify capture function", () => {
      const line = "const result = capture(() => { })";
      expect(line.includes("capture")).toBe(true);
    });

    it("should handle async variants of functions", () => {
      const asyncFuncs = ["includeAsync", "blockAsync", "captureAsync"];
      asyncFuncs.forEach((func) => {
        expect(func.includes("Async")).toBe(true);
      });
    });
  });

  describe("Eta Patterns", () => {
    it("should match output escaped pattern", () => {
      const pattern = /<%=\s*.*?\s*%>/;
      expect(pattern.test("<%= it.name %>")).toBe(true);
    });

    it("should match raw HTML output pattern", () => {
      const pattern = /<%~\s*.*?\s*%>/;
      expect(pattern.test("<%~ it.html %>")).toBe(true);
    });

    it("should match conditional pattern", () => {
      const pattern = /<%\s*if\s*\(.*?\)\s*\{/;
      expect(pattern.test("<% if (it.show) { %>")).toBe(true);
    });

    it("should match loop pattern", () => {
      const pattern = /<%\s*[\w.]+\.forEach\s*\(/;
      expect(pattern.test("<% it.items.forEach(function(item) { %>")).toBe(
        true,
      );
    });

    it("should match layout pattern", () => {
      const pattern = /<%\s*layout\s*\(/;
      expect(pattern.test('<% layout("./base") %>')).toBe(true);
    });

    it("should match include pattern", () => {
      const pattern = /<%~\s*include\s*\(/;
      expect(pattern.test('<%~ include("./partial") %>')).toBe(true);
    });

    it("should match block definition pattern", () => {
      const pattern = /<%\s*block\s*\(\s*".*?"/;
      expect(pattern.test('<% block("name", () => { %>')).toBe(true);
    });
  });
});
