import * as vscode from "vscode";
import * as path from "node:path";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { createExtensionLogger, type EtaLogger } from "./logging";
import { findEtaTagRanges } from "./etaScanner";

let client: LanguageClient;
let log: vscode.LogOutputChannel;
let logger: EtaLogger;

// Define built-in Eta functions and helpers
const ETA_BUILTINS: { [key: string]: any } = {
  // Template control
  layout: {
    label: "layout",
    kind: vscode.CompletionItemKind.Function,
    detail: "Set parent layout",
    documentation:
      'Sets a parent layout for the current template.\n\nUsage: layout("./layoutPath")\nor\nlayout("./layoutPath", { data })',
    insertText: 'layout("${1:./layout}"${2:, { ${3:title: "value"} }})$0',
  },
  include: {
    label: "include",
    kind: vscode.CompletionItemKind.Function,
    detail: "Include a partial template",
    documentation:
      'Renders a partial template inline.\n\nUsage: include("./partialPath")\nor\ninclude("./partialPath", { data })',
    insertText: 'include("${1:./partial}"${2:, { ${3:data}} })$0',
  },
  includeAsync: {
    label: "includeAsync",
    kind: vscode.CompletionItemKind.Function,
    detail: "Include an async partial template",
    documentation:
      'Renders an async partial template inline.\n\nUsage: await includeAsync("./partialPath")',
    insertText: 'await includeAsync("${1:./partial}")$0',
  },
  block: {
    label: "block",
    kind: vscode.CompletionItemKind.Function,
    detail: "Define or render a named block",
    documentation:
      'Define a named block in child template or render in layout.\n\nDefine: block("name", () => { /* content */ })\nRender: block("name")\nRender with fallback: block("name", () => { /* fallback */ })',
    insertText:
      'block("${1:blockname}"${2:, () => { %>\\n\\t${3:content}\\n<% }})$0',
  },
  blockAsync: {
    label: "blockAsync",
    kind: vscode.CompletionItemKind.Function,
    detail: "Define or render an async block",
    documentation:
      "Async version of block() for operations that need to await.",
    insertText:
      'blockAsync("${1:blockname}", async () => { %>\\n\\t${2:content}\\n<% })$0',
  },
  output: {
    label: "output",
    kind: vscode.CompletionItemKind.Function,
    detail: "Append string to output",
    documentation:
      'Directly appends a string to template output. Useful in loops or conditionals.\n\nUsage: output("<content>")',
    insertText: 'output("${1:content}")$0',
  },
  capture: {
    label: "capture",
    kind: vscode.CompletionItemKind.Function,
    detail: "Capture template output as string",
    documentation:
      "Executes template code and returns output as string instead of writing to output.\n\nUsage: const result = capture(() => { /* template code */ })",
    insertText: "capture(() => { %>\\n\\t${1:content}\\n<% })$0",
  },
  captureAsync: {
    label: "captureAsync",
    kind: vscode.CompletionItemKind.Function,
    detail: "Capture async template output as string",
    documentation: "Async version of capture() for use with renderAsync.",
    insertText:
      "await captureAsync(async () => { %>\\n\\t${1:content}\\n<% })$0",
  },
  // Data reference
  it: {
    label: "it",
    kind: vscode.CompletionItemKind.Variable,
    detail: "Template data object",
    documentation:
      "The global variable containing template data.\n\nAccess properties via it.propertyName\nExample: it.title, it.user.name",
  },
};

// Tag types and their info
const TAG_TYPES: { [key: string]: any } = {
  "<%": { name: "execute", color: "keyword", desc: "Execute JavaScript" },
  "<%=": {
    name: "output-escaped",
    color: "string",
    desc: "Output escaped value",
  },
  "<%~": { name: "output-raw", color: "string", desc: "Output raw HTML" },
  "<%#": {
    name: "custom-tag",
    color: "comment",
    desc: "Custom tag (user-configured, e.g. comment)",
  },
  "<%*": {
    name: "custom-tag",
    color: "variable",
    desc: "Custom tag (user-configured)",
  },
  "<%@": {
    name: "custom-tag",
    color: "variable",
    desc: "Custom tag (user-configured)",
  },
  "<%-": {
    name: "whitespace-trim",
    color: "keyword",
    desc: "Execute + trim 1 newline before tag",
  },
  "<%_": {
    name: "whitespace-trim",
    color: "keyword",
    desc: "Execute + trim all whitespace before tag",
  },
};

function positionToOffset(text: string, line: number, character: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < line; i++) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  return offset + character;
}

function isInsideEtaTag(
  document: vscode.TextDocument,
  position: vscode.Position,
): boolean {
  const text = document.getText();
  const offset = positionToOffset(text, position.line, position.character);
  return findEtaTagRanges(text).some(
    (range) => offset >= range.start + 2 && offset < range.end,
  );
}

class EtaCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext,
  ): vscode.CompletionItem[] {
    const line = document.lineAt(position).text;
    const lineUpto = line.substring(0, position.character);
    const completions: vscode.CompletionItem[] = [];

    // Check if inside Eta tag
    const inTag = isInsideEtaTag(document, position);

    if (inTag) {
      // Add Eta functions and helpers
      for (const [, item] of Object.entries(ETA_BUILTINS)) {
        const completion = new vscode.CompletionItem(item.label, item.kind);
        completion.detail = item.detail;
        completion.documentation = new vscode.MarkdownString(
          item.documentation || "",
        );
        if (item.insertText) {
          completion.insertText = new vscode.SnippetString(item.insertText);
        }
        completions.push(completion);
      }

      // Add common JavaScript methods/functions
      const jsCompletions = [
        {
          label: "forEach",
          kind: vscode.CompletionItemKind.Method,
          doc: "Iterate over array items",
        },
        {
          label: "map",
          kind: vscode.CompletionItemKind.Method,
          doc: "Transform array items",
        },
        {
          label: "filter",
          kind: vscode.CompletionItemKind.Method,
          doc: "Filter array items",
        },
        {
          label: "reduce",
          kind: vscode.CompletionItemKind.Method,
          doc: "Reduce array to single value",
        },
        {
          label: "join",
          kind: vscode.CompletionItemKind.Method,
          doc: "Join array to string",
        },
        {
          label: "length",
          kind: vscode.CompletionItemKind.Property,
          doc: "Array/string length",
        },
        {
          label: "Object.keys",
          kind: vscode.CompletionItemKind.Function,
          doc: "Get object keys",
        },
        {
          label: "Object.values",
          kind: vscode.CompletionItemKind.Function,
          doc: "Get object values",
        },
        {
          label: "Object.entries",
          kind: vscode.CompletionItemKind.Function,
          doc: "Get object entries",
        },
      ];

      for (const jsComp of jsCompletions) {
        const item = new vscode.CompletionItem(jsComp.label, jsComp.kind);
        item.detail = jsComp.doc;
        completions.push(item);
      }
    }

    // Tag trigger completions
    if (lineUpto.endsWith("<%")) {
      const tagCompletions = [
        { label: "<%", insertText: "<%", detail: "Execute JavaScript" },
        { label: "<%=", insertText: "<%=", detail: "Output escaped value" },
        { label: "<%~", insertText: "<%~", detail: "Output raw HTML" },
        {
          label: "<%#",
          insertText: "<%#",
          detail: "Custom tag (user-configured)",
        },
        {
          label: "<%*",
          insertText: "<%*",
          detail: "Custom tag (user-configured)",
        },
        {
          label: "<%@",
          insertText: "<%@",
          detail: "Custom tag (user-configured)",
        },
        {
          label: "<%-",
          insertText: "<%-",
          detail: "Execute + trim 1 newline before",
        },
        {
          label: "<%_",
          insertText: "<%_",
          detail: "Execute + trim all whitespace before",
        },
      ];
      for (const tag of tagCompletions) {
        const item = new vscode.CompletionItem(
          tag.label,
          vscode.CompletionItemKind.Keyword,
        );
        item.detail = tag.detail;
        item.insertText = tag.insertText;
        completions.push(item);
      }
    }

    return completions;
  }

  resolveCompletionItem(
    item: vscode.CompletionItem,
    token: vscode.CancellationToken,
  ): vscode.CompletionItem {
    return item;
  }
}

class EtaHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.Hover | null {
    const range = document.getWordRangeAtPosition(position);
    if (!range) {
      return null;
    }

    const word = document.getText(range);

    // Check if word is in our builtins
    if (ETA_BUILTINS[word]) {
      const item = ETA_BUILTINS[word];
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**${item.label}**\n\n`);
      markdown.appendMarkdown(`${item.detail}\n\n`);
      markdown.appendMarkdown(`---\n\n`);
      markdown.appendMarkdown(item.documentation || "");
      return new vscode.Hover(markdown);
    }

    // Check if hovering over a tag opener.
    // Sort longest-first so <%=, <%~, <%# etc. match before the bare <%.
    const line = document.lineAt(position).text;
    const sortedTags = Object.entries(TAG_TYPES).sort(
      (a, b) => b[0].length - a[0].length,
    );
    for (const [tag, info] of sortedTags) {
      let idx = line.indexOf(tag);
      while (idx !== -1) {
        // Cursor must be within the tag characters themselves (e.g. <, %, =)
        if (
          position.character >= idx &&
          position.character < idx + tag.length
        ) {
          const markdown = new vscode.MarkdownString();
          markdown.appendMarkdown(`**${tag}** - ${info.desc}\n\n`);
          markdown.appendMarkdown(`Type: \`${info.name}\`\n\n`);
          return new vscode.Hover(markdown);
        }
        idx = line.indexOf(tag, idx + 1);
      }
    }

    return null;
  }
}

class EtaDiagnosticsProvider {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  constructor() {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("eta");
  }

  provideDiagnostics(document: vscode.TextDocument): void {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    const ranges = findEtaTagRanges(text);

    for (const tag of ranges) {
      const start = document.positionAt(tag.start);
      const end = document.positionAt(tag.end);
      if (!tag.closed) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(start, end),
          "Unclosed Eta tag",
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = "Eta Linter";
        diagnostics.push(diagnostic);
      } else if (tag.empty) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(start, end),
          "Empty Eta tag",
          vscode.DiagnosticSeverity.Information,
        );
        diagnostic.source = "Eta Linter";
        diagnostics.push(diagnostic);
      }
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
    if (diagnostics.length > 0) {
      logger?.warn(
        `${path.basename(document.fileName)}: ${diagnostics.length} diagnostic(s) - ` +
          diagnostics.map((d) => d.message).join(" | "),
      );
    }
  }

  dispose(): void {
    this.diagnosticCollection.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel("Eta", { log: true });
  logger = createExtensionLogger(log);
  context.subscriptions.push(log);
  logger.info("Extension activated");

  // Register completion provider
  const completionProvider = new EtaCompletionProvider();
  const hoverProvider = new EtaHoverProvider();
  const diagnosticsProvider = new EtaDiagnosticsProvider();

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      "eta",
      completionProvider,
      "<",
      ".",
      " ",
    ),
    vscode.languages.registerHoverProvider("eta", hoverProvider),
    diagnosticsProvider,
    vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument) => {
      if (document.languageId === "eta") {
        logger.debug(`Opened ${document.fileName}`);
        diagnosticsProvider.provideDiagnostics(document);
      }
    }),
    vscode.workspace.onDidChangeTextDocument(
      (event: vscode.TextDocumentChangeEvent) => {
        if (event.document.languageId === "eta") {
          diagnosticsProvider.provideDiagnostics(event.document);
        }
      },
    ),
  );

  // Provide diagnostics for currently open documents
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.languageId === "eta") {
      logger.debug(
        `Providing initial diagnostics for ${editor.document.fileName}`,
      );
      diagnosticsProvider.provideDiagnostics(editor.document);
    }
  }

  // ── Language Server (JS/TS IntelliSense inside Eta tags) ─────────────────
  const serverModule = context.asAbsolutePath(path.join("out", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "eta" }],
    synchronize: {
      // Forward TS/JS file changes to the server so it can re-infer `it` types
      fileEvents: vscode.workspace.createFileSystemWatcher(
        "**/*.{ts,tsx,js,jsx}",
      ),
    },
  };
  client = new LanguageClient(
    "eta-lsp",
    "Eta Language Server",
    serverOptions,
    clientOptions,
  );
  logger.info(`Starting language server: ${serverModule}`);
  client
    .start()
    .then(() => {
      logger.info("Language server started");
    })
    .catch((err: unknown) => {
      logger.error(`Language server failed to start: ${err}`);
    });
}

export function deactivate(): Thenable<void> | undefined {
  logger?.info("Extension deactivated");
  if (!client) return undefined;
  return client.stop();
}
