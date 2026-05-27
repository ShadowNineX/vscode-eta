import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  FileChangeType,
  Hover,
  MarkupKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import ts from "typescript";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVirtualContent, PREAMBLE_LINE_COUNT } from "./virtualDocument";
import { isInsideEtaTagInText, positionToOffset } from "./position";
import { tsKindToLSP } from "./lspKind";
import { createServerLogger } from "./logging";
import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
  applyNonDefaultEtaLanguageOptions,
  normalizeEtaLanguageOptions,
} from "./etaConfig";
import {
  analyzeWorkspaceFiles,
  getEtaLanguageOptionsForUri,
  getItTypeForUri,
  scanWorkspaceFiles,
  templateDataTypeMap,
  templateLanguageOptionsMap,
  workspaceEtaFiles,
  workspaceTsFiles,
} from "./typeInference";

export {
  consumeTagContent,
  consumeTagOpener,
  findEtaTagRanges,
} from "./etaScanner";
export type { EtaTagRange } from "./etaScanner";
export {
  buildPreamble,
  buildVirtualContent,
  buildVirtualLine,
  DEFAULT_IT_TYPE,
  PREAMBLE_LINE_COUNT,
} from "./virtualDocument";
export {
  isInsideEtaTag,
  isInsideEtaTagInText,
  positionToOffset,
} from "./position";
export { tsKindToLSP } from "./lspKind";
export {
  analyzeFileForEtaCalls,
  analyzeEtaTemplateLayouts,
  analyzeWorkspaceFiles,
  getEtaLanguageOptionsForUri,
  getItTypeForUri,
  scanWorkspaceFiles,
  templateDataTypeMap,
  templateLanguageOptionsMap,
  workspaceEtaFiles,
  typeToStructuralString,
  workspaceTsFiles,
} from "./typeInference";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analysisLog = createServerLogger(connection.console, "analysis");
const documentLog = createServerLogger(connection.console, "document");
const virtualLog = createServerLogger(connection.console, "virtual");

const virtualContents = new Map<string, string>(); // virtualPath -> content
const uriToVirtualPath = new Map<string, string>(); // uri -> virtualPath

let workspaceRoot: string | undefined;
let workspaceAnalyzed = false;
let nextVirtualId = 0;
let serviceVersion = 0;
let languageService: ts.LanguageService | null = null;
let etaLanguageOptions: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS;

function getVirtualPath(uri: string): string {
  let vp = uriToVirtualPath.get(uri);
  if (vp === undefined) {
    vp = `virtual_eta_${nextVirtualId++}.ts`;
    uriToVirtualPath.set(uri, vp);
  }
  return vp;
}

function ensureWorkspaceAnalyzed(): void {
  if (workspaceAnalyzed) return;
  workspaceAnalyzed = true;
  runWorkspaceAnalysis();
}

function runWorkspaceAnalysis(): void {
  templateDataTypeMap.clear();
  templateLanguageOptionsMap.clear();
  serviceVersion++;

  const rootNames = [...workspaceTsFiles];
  analysisLog.info(`Scanning ${rootNames.length} workspace files`);

  if (rootNames.length > 0) {
    analyzeWorkspaceFiles(rootNames, {
      onError: (fileName, error) => {
        analysisLog.error(`${path.basename(fileName)}: ${error}`);
      },
      onFailure: (error) => {
        analysisLog.error(`Workspace analysis failed: ${error}`);
      },
      onMapping: (fileName, key, value) => {
        analysisLog.debug(
          `${path.basename(fileName)}: "${key}" -> ${value.substring(0, 100)}`,
        );
      },
    });
  }

  analysisLog.info(
    `Complete - map entries: [${[...templateDataTypeMap.keys()].join(", ")}]`,
  );
  for (const [k, v] of templateDataTypeMap) {
    analysisLog.debug(`"${k}" -> ${v.substring(0, 120)}`);
  }

  rebuildOpenVirtualFiles();
}

function getDocumentLanguageOptions(uri: string): EtaLanguageOptions {
  const inferredOptions =
    getEtaLanguageOptionsForUri(uri) ?? DEFAULT_ETA_LANGUAGE_OPTIONS;
  return applyNonDefaultEtaLanguageOptions(
    inferredOptions,
    etaLanguageOptions,
  );
}

function rebuildOpenVirtualFiles(): void {
  for (const uri of uriToVirtualPath.keys()) {
    const doc = documents.get(uri);
    if (doc) updateVirtualFile(uri, doc.getText());
  }
}

function isWorkspaceSourceFile(fsPath: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx"].includes(path.extname(fsPath));
}

function isEtaTemplateFile(fsPath: string): boolean {
  return path.extname(fsPath) === ".eta";
}

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
  const options = getDocumentLanguageOptions(uri);
  const newContent = buildVirtualContent(
    etaSource,
    itType,
    options,
  );

  if (virtualContents.get(virtualPath) !== newContent) {
    virtualContents.set(virtualPath, newContent);
    serviceVersion++;
    try {
      virtualLog.debug(
        `${path.basename(fileURLToPath(uri))} -> it: ${itType.substring(0, 120)}`,
      );
    } catch {
      // fileURLToPath may fail for non-file URIs
    }
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  etaLanguageOptions = normalizeEtaLanguageOptions(
    params.initializationOptions?.etaLanguageOptions,
  );
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
        triggerCharacters: [".", "(", '"', "'", "{", "<"],
      },
      hoverProvider: true,
    },
  };
});

connection.onDidChangeConfiguration?.((change) => {
  etaLanguageOptions = normalizeEtaLanguageOptions(
    change.settings?.etaLanguageOptions ?? change.settings?.eta,
  );
  serviceVersion++;
  rebuildOpenVirtualFiles();
});

documents.onDidOpen((event) => {
  try {
    documentLog.debug(
      `Opened ${path.basename(fileURLToPath(event.document.uri))}`,
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
        workspaceEtaFiles.delete(fsPath);
      } else if (isWorkspaceSourceFile(fsPath)) {
        workspaceTsFiles.add(fsPath);
      } else if (isEtaTemplateFile(fsPath)) {
        workspaceEtaFiles.add(fsPath);
      } else {
        continue;
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

  const docText = doc.getText();
  if (
    !isInsideEtaTagInText(
      docText,
      params.position.line,
      params.position.character,
      getDocumentLanguageOptions(params.textDocument.uri),
    )
  ) {
    return [];
  }

  const virtualPath = getVirtualPath(params.textDocument.uri);
  updateVirtualFile(params.textDocument.uri, docText);

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

  const docText = doc.getText();
  if (
    !isInsideEtaTagInText(
      docText,
      params.position.line,
      params.position.character,
      getDocumentLanguageOptions(params.textDocument.uri),
    )
  ) {
    return null;
  }

  const virtualPath = getVirtualPath(params.textDocument.uri);
  updateVirtualFile(params.textDocument.uri, docText);

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
  const documentationText =
    info.documentation?.map((p) => p.text).join("") ?? "";

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value:
        "```typescript\n" +
        displayText +
        "\n```" +
        (documentationText ? "\n\n" + documentationText : ""),
    },
  };
});

documents.listen(connection);
connection.listen();
