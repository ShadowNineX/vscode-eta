import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  CompletionItemKind,
  FileChangeType,
  Hover,
  MarkupKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as ts from "typescript";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// ── Preamble ─────────────────────────────────────────────────────────────────

export const DEFAULT_IT_TYPE = "Record<string, any>";

/** Eta built-in function declarations (8 lines, each ending with \n). */
const ETA_BUILTINS = [
  `declare function include(path: string, data?: Record<string, any>): string;`,
  `declare function includeAsync(path: string, data?: Record<string, any>): Promise<string>;`,
  `declare function layout(path: string, data?: Record<string, any>): void;`,
  `declare function block(name: string, fn?: () => void): string;`,
  `declare function blockAsync(name: string, fn?: () => Promise<void>): Promise<string>;`,
  `declare function output(content: string): void;`,
  `declare function capture(fn: () => void): string;`,
  `declare function captureAsync(fn: () => Promise<void>): Promise<string>;`,
].join("\n");

/**
 * Build the 9-line preamble injected at the top of every virtual TS file.
 * The `it` declaration is always a single line so PREAMBLE_LINE_COUNT is fixed.
 */
export function buildPreamble(itType: string): string {
  const safe = itType.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return `declare const it: ${safe};\n${ETA_BUILTINS}\n`;
}

/** Always 9 lines: 1 (`it`) + 8 (built-ins). Verified by test. */
export const PREAMBLE_LINE_COUNT = 9;

// ── Virtual file management ───────────────────────────────────────────────────

const virtualContents = new Map<string, string>(); // virtualPath -> content
const uriToVirtualPath = new Map<string, string>(); // uri -> virtualPath
let nextVirtualId = 0;
let serviceVersion = 0;

function getVirtualPath(uri: string): string {
  let vp = uriToVirtualPath.get(uri);
  if (vp === undefined) {
    vp = `virtual_eta_${nextVirtualId++}.ts`;
    uriToVirtualPath.set(uri, vp);
  }
  return vp;
}

/**
 * Build a virtual TypeScript file from Eta source.
 * Prepends a 9-line preamble (with the correct `it` type), then for each
 * source line replaces non-tag characters with spaces so that offsets inside
 * tags are preserved exactly.
 */
export function buildVirtualContent(
  etaSource: string,
  itType: string = DEFAULT_IT_TYPE,
): string {
  return (
    buildPreamble(itType) +
    etaSource.split("\n").map(buildVirtualLine).join("\n") +
    // Append a module marker so TypeScript treats this as a module (not a
    // global script).  Without it every virtual file shares the same global
    // scope, causing the `it` declaration from one template to bleed into
    // type queries for another template.
    "\nexport {};"
  );
}

/** Consume the <% opener and its modifier chars; returns chars consumed and new index. */
export function consumeTagOpener(
  line: string,
  start: number,
): { padLen: number; next: number } {
  let i = start + 2; // skip <%
  if (i < line.length && "=~#*".includes(line[i])) {
    i++;
  } else if (i < line.length && (line[i] === "-" || line[i] === "_")) {
    i++;
    if (i < line.length && (line[i] === "=" || line[i] === "~")) {
      i++; // e.g. <%-= or <%_~
    }
  }
  return { padLen: i - start, next: i };
}

/** Consume JS content until closing %> (or -%> / _%>); returns js text and new index. */
export function consumeTagContent(
  line: string,
  start: number,
): { js: string; next: number } {
  let js = "";
  let i = start;
  while (i < line.length) {
    const ch = line[i];
    if (
      (ch === "-" || ch === "_") &&
      line[i + 1] === "%" &&
      line[i + 2] === ">"
    ) {
      return { js: js + "   ", next: i + 3 }; // -%> or _%>
    }
    if (ch === "%" && line[i + 1] === ">") {
      return { js: js + "  ", next: i + 2 }; // %>
    }
    js += ch;
    i++;
  }
  return { js, next: i };
}

export function buildVirtualLine(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "<" && line[i + 1] === "%") {
      const opener = consumeTagOpener(line, i);
      out += " ".repeat(opener.padLen);
      const content = consumeTagContent(line, opener.next);
      out += content.js;
      i = content.next;
    } else {
      out += " "; // non-tag content → space (preserves positions)
      i++;
    }
  }
  return out;
}

// ── Workspace analysis ────────────────────────────────────────────────────────────────

let workspaceRoot: string | undefined;
/** Absolute fs paths of every .ts/.js file found in the workspace. */
export const workspaceTsFiles = new Set<string>();
/** Maps Eta template basename (no extension) → inferred `it` type string. */
export const templateDataTypeMap = new Map<string, string>();
let workspaceAnalyzed = false;

/** Scan the workspace root for TS/JS source files (excludes node_modules etc.). */
export function scanWorkspaceFiles(root: string): void {
  try {
    const files = ts.sys.readDirectory(
      root,
      [".ts", ".tsx", ".js", ".jsx"],
      ["node_modules", ".git", "out", "dist", "build"],
    );
    for (const f of files) {
      // ts.sys.readDirectory only excludes the top-level directory names; nested
      // node_modules (e.g. demo/node_modules) are not excluded by the pattern alone.
      if (f.includes("node_modules")) continue;
      workspaceTsFiles.add(f);
    }
  } catch {
    // silently ignore; proceed without workspace context
  }
}

const ETA_RENDER_METHODS = new Set([
  "render",
  "renderFile",
  "renderString",
  "renderAsync",
  "renderFileAsync",
  "renderStringAsync",
]);

/** Maximum recursion depth when expanding object types to avoid infinite loops. */
const MAX_TYPE_DEPTH = 6;

/**
 * Recursively convert a TypeScript `Type` to a self-contained structural type
 * string that is safe to embed in `declare const it: <here>` without any
 * external imports.
 *
 * - Named interfaces / type aliases → expanded to `{ prop: type; … }`
 * - Class instances               → kept as the class name (not expanded)
 * - Primitives / literals         → widened to their base keyword
 * - Arrays / tuples               → recursively expanded element types
 * - Union / intersection          → both sides recursively expanded
 */
/** Returns a primitive keyword for the given TypeFlags, or undefined. */
function primitiveFromFlags(f: ts.TypeFlags): string | undefined {
  if (f & ts.TypeFlags.String) return "string";
  if (f & ts.TypeFlags.Number) return "number";
  if (f & ts.TypeFlags.Boolean) return "boolean";
  if (f & ts.TypeFlags.BigInt) return "bigint";
  if (f & ts.TypeFlags.Null) return "null";
  if (f & ts.TypeFlags.Undefined) return "undefined";
  if (f & ts.TypeFlags.Void) return "void";
  if (f & ts.TypeFlags.Any) return "any";
  if (f & ts.TypeFlags.Unknown) return "unknown";
  if (f & ts.TypeFlags.Never) return "never";
  return undefined;
}

/** Converts a literal type to its source-text representation, or undefined. */
function literalTypeToString(type: ts.Type): string | undefined {
  if (type.isStringLiteral()) return JSON.stringify(type.value);
  if (type.isNumberLiteral()) return String(type.value);
  if (type.flags & ts.TypeFlags.BooleanLiteral) return "boolean";
  if (type.flags & ts.TypeFlags.BigIntLiteral) return "bigint";
  return undefined;
}

/** Expands an object/interface type into `{ prop: type; … }` notation. */
function expandObjectType(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number,
): string {
  const props = checker.getPropertiesOfType(type);
  if (props.length === 0) {
    const raw = checker
      .typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return raw === "{}" ? "Record<string, unknown>" : raw;
  }
  const parts = props.map((prop) => {
    const optional = prop.flags & ts.SymbolFlags.Optional ? "?" : "";
    try {
      const propStr = typeToStructuralString(
        checker,
        checker.getTypeOfSymbol(prop),
        depth + 1,
      );
      return `${prop.name}${optional}: ${propStr}`;
    } catch {
      return `${prop.name}${optional}: unknown`;
    }
  });
  return `{ ${parts.join("; ")} }`;
}

export function typeToStructuralString(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth = 0,
): string {
  if (depth > MAX_TYPE_DEPTH) return "unknown";

  // Union  (A | B)
  if (type.isUnion()) {
    const unique = [
      ...new Set(
        type.types.map((t) => typeToStructuralString(checker, t, depth + 1)),
      ),
    ];
    return unique.join(" | ");
  }

  // Intersection  (A & B)
  if (type.isIntersection()) {
    return type.types
      .map((t) => typeToStructuralString(checker, t, depth + 1))
      .join(" & ");
  }

  const primitive = primitiveFromFlags(type.flags);
  if (primitive !== undefined) return primitive;

  // Preserve literals (important for union discriminators like `status: "draft" | "published"`)
  const literal = literalTypeToString(type);
  if (literal !== undefined) return literal;

  // Array<T>  /  T[]
  if (checker.isArrayType(type)) {
    const el = checker.getTypeArguments(type as ts.TypeReference)[0];
    return el ? `${typeToStructuralString(checker, el, depth + 1)}[]` : "any[]";
  }

  // Tuple  [A, B, …]
  if (checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    return `[${args.map((t) => typeToStructuralString(checker, t, depth + 1)).join(", ")}]`;
  }

  // Class instances: keep the constructor name, don't expand methods
  if (type.getConstructSignatures().length > 0) {
    return type.getSymbol()?.name ?? checker.typeToString(type);
  }

  // Function types: keep the call signature
  if (type.getCallSignatures().length > 0) {
    return checker
      .typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Object / interface / type alias → expand every property recursively
  return expandObjectType(checker, type, depth);
}

/** Returns the called method name from a call-expression target, or undefined. */
function getCalledMethodName(expr: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return undefined;
}

/** Records the structural type of a render-call's data argument in templateDataTypeMap. */
function recordRenderCallType(
  templateName: string,
  dataArg: ts.Expression,
  checker: ts.TypeChecker,
): void {
  const basename = path.basename(templateName, path.extname(templateName));
  try {
    const type = checker.getTypeAtLocation(dataArg);
    const typeStr = typeToStructuralString(checker, type);
    if (typeStr === "any" || typeStr === "unknown") return;
    const existing = templateDataTypeMap.get(basename);
    templateDataTypeMap.set(
      basename,
      existing && existing !== typeStr ? `${existing} & ${typeStr}` : typeStr,
    );
  } catch {
    // type extraction failed for this call; skip
  }
}

/**
 * Walk one source file's AST looking for `eta.render*(templateLiteral, data)`
 * calls and record the inferred structural type of `data` in
 * `templateDataTypeMap`.  Multiple call sites for the same template are merged
 * via intersection so all available properties appear in IntelliSense.
 */
export function analyzeFileForEtaCalls(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): void {
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const methodName = getCalledMethodName(node.expression);
      if (methodName && ETA_RENDER_METHODS.has(methodName)) {
        const args = node.arguments;
        if (args.length >= 2 && ts.isStringLiteral(args[0])) {
          recordRenderCallType(args[0].text, args[1], checker);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

/** Run workspace analysis once; subsequent calls are no-ops. */
function ensureWorkspaceAnalyzed(): void {
  if (workspaceAnalyzed) return;
  workspaceAnalyzed = true;
  runWorkspaceAnalysis();
}

/** Analyze a single source file and log any newly-added type mappings. */
function analyzeOneSourceFile(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): void {
  const before = new Map(templateDataTypeMap);
  try {
    analyzeFileForEtaCalls(sf, checker);
  } catch (e) {
    connection.console?.log(
      `[eta] Error in ${path.basename(sf.fileName)}: ${e}`,
    );
  }
  for (const [k, v] of templateDataTypeMap) {
    if (!before.has(k) || before.get(k) !== v) {
      connection.console?.log(
        `[eta] ${path.basename(sf.fileName)}: "${k}" → ${v.substring(0, 100)}`,
      );
    }
  }
}

/** Build a program from the given files and analyze each one. */
function analyzeWorkspaceFiles(rootNames: string[]): void {
  try {
    // Use ts.createProgram (not the LanguageService) so analysis is
    // completely isolated from virtual file state and LS caching.
    const program = ts.createProgram({
      rootNames,
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
    const rootSet = new Set(rootNames);
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || !rootSet.has(sf.fileName)) continue;
      analyzeOneSourceFile(sf, checker);
    }
  } catch (e) {
    connection.console?.log(`[eta] Workspace analysis failed: ${e}`);
  }
}

/** (Re-)scan all workspace TS/JS files and rebuild every open virtual file. */
function runWorkspaceAnalysis(): void {
  templateDataTypeMap.clear();
  serviceVersion++; // force TS LS to re-read virtual files with new it types

  const rootNames = [...workspaceTsFiles];
  connection.console?.log(
    `[eta] runWorkspaceAnalysis: ${rootNames.length} workspace files`,
  );

  if (rootNames.length > 0) {
    analyzeWorkspaceFiles(rootNames);
  }

  connection.console?.log(
    `[eta] analysis complete — map entries: [${[...templateDataTypeMap.keys()].join(", ")}]`,
  );
  for (const [k, v] of templateDataTypeMap) {
    connection.console?.log(`[eta]   "${k}" → ${v.substring(0, 120)}`);
  }

  // Rebuild every open .eta virtual file so it picks up the new it types
  for (const uri of uriToVirtualPath.keys()) {
    const doc = documents.get(uri);
    if (doc) updateVirtualFile(uri, doc.getText());
  }
}

/** Return the `it` type inferred for this template URI, or the default. */
export function getItTypeForUri(uri: string): string {
  try {
    const fsPath = fileURLToPath(uri);
    const basename = path.basename(fsPath, path.extname(fsPath));
    const inferred = templateDataTypeMap.get(basename);
    if (!inferred) {
      connection.console?.log(
        `[eta] getItTypeForUri: "${basename}" not in map (${templateDataTypeMap.size} entries) → default`,
      );
    }
    return inferred ?? DEFAULT_IT_TYPE;
  } catch {
    return DEFAULT_IT_TYPE;
  }
}

// ── TypeScript Language Service ─────────────────────────────────────────────────────

let languageService: ts.LanguageService | null = null;

function getLanguageService(): ts.LanguageService {
  if (languageService) return languageService;

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [
      ...Array.from(virtualContents.keys()),
      ...Array.from(workspaceTsFiles),
    ],
    getScriptVersion: () => String(serviceVersion),
    getScriptSnapshot: (fileName) => {
      const content = virtualContents.get(fileName);
      if (content !== undefined) return ts.ScriptSnapshot.fromString(content);
      const disk = ts.sys.readFile(fileName);
      return disk === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(disk);
    },
    getCurrentDirectory: () => workspaceRoot ?? process.cwd(),
    getCompilationSettings: (): ts.CompilerOptions => ({
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
    }),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (f) =>
      virtualContents.has(f) || workspaceTsFiles.has(f) || ts.sys.fileExists(f),
    readFile: (f) => virtualContents.get(f) ?? ts.sys.readFile(f),
    readDirectory: ts.sys.readDirectory.bind(ts.sys),
    directoryExists: ts.sys.directoryExists?.bind(ts.sys),
    getDirectories: ts.sys.getDirectories?.bind(ts.sys),
  };

  languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
  return languageService;
}

function updateVirtualFile(uri: string, etaSource: string): void {
  const virtualPath = getVirtualPath(uri);
  const itType = getItTypeForUri(uri);
  const newContent = buildVirtualContent(etaSource, itType);
  // Only bump serviceVersion when content actually changed so hover/completion
  // can safely call this on every request without thrashing the LS cache.
  if (virtualContents.get(virtualPath) !== newContent) {
    virtualContents.set(virtualPath, newContent);
    serviceVersion++;
    try {
      connection.console?.log(
        `[eta] virtual updated: ${path.basename(fileURLToPath(uri))} → it: ${itType.substring(0, 120)}`,
      );
    } catch {
      // fileURLToPath may fail for non-file URIs
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function positionToOffset(
  content: string,
  line: number,
  character: number,
): number {
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for \n
  }
  return offset + character;
}

export function isInsideEtaTag(line: string, character: number): boolean {
  let depth = 0;
  for (let i = 0; i < character && i < line.length; i++) {
    if (line[i] === "<" && i + 1 < line.length && line[i + 1] === "%") {
      depth++;
      i++;
    } else if (line[i] === "%" && i + 1 < line.length && line[i + 1] === ">") {
      depth--;
      i++;
    }
  }
  return depth > 0;
}

export function tsKindToLSP(kind: string): CompletionItemKind {
  switch (kind) {
    case "function":
    case "local function":
      return CompletionItemKind.Function;
    case "method":
      return CompletionItemKind.Method;
    case "property":
    case "accessor":
    case "member":
      return CompletionItemKind.Property;
    case "class":
      return CompletionItemKind.Class;
    case "interface":
      return CompletionItemKind.Interface;
    case "module":
      return CompletionItemKind.Module;
    case "variable":
    case "local var":
      return CompletionItemKind.Variable;
    case "const":
      return CompletionItemKind.Constant;
    case "keyword":
      return CompletionItemKind.Keyword;
    case "type":
      return CompletionItemKind.TypeParameter;
    default:
      return CompletionItemKind.Text;
  }
}

// ── LSP handlers ──────────────────────────────────────────────────────────────

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const rootUri = params.workspaceFolders?.[0]?.uri;
  if (rootUri) {
    try {
      workspaceRoot = fileURLToPath(rootUri);
      scanWorkspaceFiles(workspaceRoot);
    } catch {
      // could not resolve workspace root; proceed without
    }
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [".", "(", '"', "'"],
      },
      hoverProvider: true,
    },
  };
});

documents.onDidOpen((event) => {
  try {
    connection.console?.log(
      `[eta] onDidOpen: ${path.basename(fileURLToPath(event.document.uri))}`,
    );
  } catch {
    // ignore
  }
  ensureWorkspaceAnalyzed();
  updateVirtualFile(event.document.uri, event.document.getText());
});

documents.onDidChangeContent((change) => {
  updateVirtualFile(change.document.uri, change.document.getText());
});

connection.onDidChangeWatchedFiles((params) => {
  let needsReanalysis = false;
  for (const change of params.changes) {
    try {
      const fsPath = fileURLToPath(change.uri);
      if (change.type === FileChangeType.Deleted) {
        workspaceTsFiles.delete(fsPath);
      } else {
        // Created or Changed — ensure it's tracked
        workspaceTsFiles.add(fsPath);
      }
      needsReanalysis = true;
    } catch {
      // unparseable URI; skip
    }
  }
  if (needsReanalysis) runWorkspaceAnalysis();
});

connection.onCompletion((params: TextDocumentPositionParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const lineText = doc.getText().split("\n")[params.position.line] ?? "";
  if (!isInsideEtaTag(lineText, params.position.character)) return [];

  const virtualPath = getVirtualPath(params.textDocument.uri);
  // Always rebuild so the latest inferred `it` type is used even if this
  // file was opened before the workspace analysis finished.  The call is
  // cheap (no-op) when the content hasn't changed.
  updateVirtualFile(params.textDocument.uri, doc.getText());

  const virtualContent = virtualContents.get(virtualPath) ?? "";
  const virtualLine = params.position.line + PREAMBLE_LINE_COUNT;
  const virtualOffset = positionToOffset(
    virtualContent,
    virtualLine,
    params.position.character,
  );

  const completions = getLanguageService().getCompletionsAtPosition(
    virtualPath,
    virtualOffset,
    { includeCompletionsForModuleExports: false },
  );

  return (completions?.entries ?? []).map((entry) => ({
    label: entry.name,
    kind: tsKindToLSP(entry.kind),
    detail: entry.kindModifiers || undefined,
  }));
});

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lineText = doc.getText().split("\n")[params.position.line] ?? "";
  if (!isInsideEtaTag(lineText, params.position.character)) return null;

  const virtualPath = getVirtualPath(params.textDocument.uri);
  // Always rebuild so the latest inferred `it` type is used even if this
  // file was opened before the workspace analysis finished.  The call is
  // cheap (no-op) when the content hasn't changed.
  updateVirtualFile(params.textDocument.uri, doc.getText());

  const virtualContent = virtualContents.get(virtualPath) ?? "";
  const virtualLine = params.position.line + PREAMBLE_LINE_COUNT;
  const virtualOffset = positionToOffset(
    virtualContent,
    virtualLine,
    params.position.character,
  );

  const info = getLanguageService().getQuickInfoAtPosition(
    virtualPath,
    virtualOffset,
  );
  if (!info?.displayParts?.length) return null;

  const displayText = info.displayParts.map((p) => p.text).join("");
  const docText = info.documentation?.map((p) => p.text).join("") ?? "";

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value:
        "```typescript\n" +
        displayText +
        "\n```" +
        (docText ? "\n\n" + docText : ""),
    },
  };
});

documents.listen(connection);
connection.listen();
