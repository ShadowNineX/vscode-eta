import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  FileChangeType,
  CompletionItemKind,
  DiagnosticSeverity,
  Hover,
  Location,
  MarkupKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import ts from "typescript";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildVirtualDocument } from "./virtualDocument";
import { getEtaDataPathAtPosition, offsetToPosition } from "./definition";
import { isInsideEtaTagInText, positionToOffset } from "./position";
import { tsKindToLSP } from "./lspKind";
import { createServerLogger } from "./logging";
import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
  applyNonDefaultEtaLanguageOptions,
  normalizeEtaLanguageOptions,
} from "./etaConfig";
import { findEtaTagRanges } from "./etaScanner";
import {
  getBlockCallContextAtOffset,
  getBlockCallContexts,
  getTemplatePathCompletions,
  getTemplatePathContextAtOffset,
} from "./templateContext";
import { resolveTemplatePath } from "./templatePaths";
import {
  analyzeWorkspaceFiles,
  getDataDefinitionsForUri,
  getEtaLanguageOptionsForUri,
  getItTypeForUri,
  getTemplateResolutionOptionsForUri,
  getWorkspaceProjectForFile,
  scanWorkspaceFiles,
  templateDataDefinitionMap,
  templateDataTypeMap,
  templateLanguageOptionsMap,
  templateResolutionOptionsMap,
  workspaceEtaFiles,
  workspaceProjects,
  workspaceTsFiles,
} from "./typeInference";
import type { WorkspaceProject } from "./typeInference";


const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analysisLog = createServerLogger(connection.console, "analysis");
const documentLog = createServerLogger(connection.console, "document");
const virtualLog = createServerLogger(connection.console, "virtual");

const virtualContents = new Map<string, string>(); // virtualPath -> content
const uriToVirtualPath = new Map<string, string>(); // uri -> virtualPath
const virtualPreambleLines = new Map<string, number>();

let workspaceRoot: string | undefined;
const workspaceRoots: string[] = [];
let workspaceAnalyzed = false;
let nextVirtualId = 0;
let serviceVersion = 0;
let languageService: ts.LanguageService | null = null;
let activeWorkspaceProject: WorkspaceProject | undefined;
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
  templateDataDefinitionMap.clear();
  templateLanguageOptionsMap.clear();
  templateResolutionOptionsMap.clear();
  serviceVersion++;

  const rootNames = [...workspaceTsFiles];
  analysisLog.info(`Scanning ${rootNames.length} workspace files`);

  if (rootNames.length > 0) {
    analyzeWorkspaceFiles(
      rootNames,
      {
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
      },
      workspaceProjects,
    );
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
    if (doc) {
      updateVirtualFile(uri, doc.getText());
      publishDiagnostics(uri);
    }
  }
}

function isWorkspaceSourceFile(fsPath: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx"].includes(path.extname(fsPath));
}

function isWorkspaceConfigFile(fsPath: string): boolean {
  const basename = path.basename(fsPath).toLowerCase();
  return basename === "tsconfig.json" || basename === "jsconfig.json";
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
    getCurrentDirectory: () =>
      activeWorkspaceProject?.root ?? workspaceRoot ?? process.cwd(),
    getCompilationSettings: (): ts.CompilerOptions =>
      activeWorkspaceProject?.options ?? {
        allowJs: true,
        checkJs: false,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
      },
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
function activateWorkspaceProject(uri: string): void {
  try {
    const project = getWorkspaceProjectForFile(fileURLToPath(uri));
    if (project === activeWorkspaceProject) return;
    activeWorkspaceProject = project;
    languageService?.dispose();
    languageService = null;
  } catch {
    // Non-file URI: retain the current project context.
  }
}


function updateVirtualFile(uri: string, etaSource: string): void {
  const virtualPath = getVirtualPath(uri);
  const itType = getItTypeForUri(uri);
  const options = getDocumentLanguageOptions(uri);
  const virtualDocument = buildVirtualDocument(etaSource, itType, options);
  const newContent = virtualDocument.content;
  virtualPreambleLines.set(virtualPath, virtualDocument.preambleLineCount);

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
  const roots = params.workspaceFolders?.map((folder) => folder.uri) ?? [];
  workspaceTsFiles.clear();
  workspaceEtaFiles.clear();
  workspaceProjects.length = 0;
  workspaceRoot = undefined;
  workspaceRoots.length = 0;
  for (const rootUri of roots) {
    try {
      const root = fileURLToPath(rootUri);
      workspaceRoot ??= root;
      workspaceRoots.push(root);
      scanWorkspaceFiles(root);
    } catch {
      // Ignore workspace folders whose URI cannot be resolved locally.
    }
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [".", "(", '"', "'", "{", "<", "/"],
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
        retriggerCharacters: [","],
      },
      semanticTokensProvider: {
        legend: { tokenTypes: ["macro"], tokenModifiers: [] },
        full: true,
      },
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
  publishDiagnostics(event.document.uri);
});

documents.onDidChangeContent((change) => {
  updateVirtualFile(change.document.uri, change.document.getText());
  publishDiagnostics(change.document.uri);
});

connection.onDidChangeWatchedFiles((params) => {
  let needsReanalysis = false;
  let configChanged = false;
  for (const change of params.changes) {
    try {
      const fsPath = fileURLToPath(change.uri);
      if (isWorkspaceConfigFile(fsPath)) {
        configChanged = true;
        needsReanalysis = true;
        continue;
      }
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
  if (configChanged) {
    workspaceTsFiles.clear();
    workspaceEtaFiles.clear();
    workspaceProjects.length = 0;
    for (const root of workspaceRoots) scanWorkspaceFiles(root);
    activeWorkspaceProject = undefined;
    languageService?.dispose();
    languageService = null;
  }
  if (needsReanalysis) runWorkspaceAnalysis();
});

interface VirtualPosition {
  docText: string;
  options: EtaLanguageOptions;
  virtualContent: string;
  virtualOffset: number;
  virtualPath: string;
  preambleLineCount: number;
}

function getVirtualPosition(
  params: TextDocumentPositionParams,
): VirtualPosition | undefined {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;

  const docText = doc.getText();
  const options = getDocumentLanguageOptions(params.textDocument.uri);
  if (
    !isInsideEtaTagInText(
      docText,
      params.position.line,
      params.position.character,
      options,
    )
  ) {
    return undefined;
  }

  const virtualPath = getVirtualPath(params.textDocument.uri);
  activateWorkspaceProject(params.textDocument.uri);
  updateVirtualFile(params.textDocument.uri, docText);
  const virtualContent = virtualContents.get(virtualPath) ?? "";
  const preambleLineCount = virtualPreambleLines.get(virtualPath) ?? 0;
  const virtualOffset = positionToOffset(
    virtualContent,
    params.position.line + preambleLineCount,
    params.position.character,
  );
  return {
    docText,
    options,
    virtualContent,
    virtualOffset,
    virtualPath,
    preambleLineCount,
  };
}

connection.onCompletion((params: TextDocumentPositionParams) => {
  const virtual = getVirtualPosition(params);
  if (!virtual) return [];
  const sourceOffset = positionToOffset(
    virtual.docText,
    params.position.line,
    params.position.character,
  );
  const pathContext = getTemplatePathContextAtOffset(
    virtual.docText,
    sourceOffset,
    virtual.options,
  );
  if (pathContext) {
    try {
      const resolutionOptions = getTemplateResolutionOptionsForUri(
        params.textDocument.uri,
      );
      return getTemplatePathCompletions(
        fileURLToPath(params.textDocument.uri),
        pathContext.value,
        workspaceEtaFiles,
        resolutionOptions?.views,
      ).map((value) => ({
        label: value,
        kind: CompletionItemKind.File,
        textEdit: {
          range: {
            start: offsetToPosition(virtual.docText, pathContext.valueStart),
            end: offsetToPosition(virtual.docText, pathContext.valueEnd),
          },
          newText: value,
        },
      }));
    } catch {
      return [];
    }
  }


  const completions = getLanguageService().getCompletionsAtPosition(
    virtual.virtualPath,
    virtual.virtualOffset,
    { includeCompletionsForModuleExports: false },
  );

  return (completions?.entries ?? []).map((entry) => ({
    label: entry.name,
    kind: tsKindToLSP(entry.kind),
    detail: entry.kindModifiers || undefined,
  }));
});

function locationFromOffsets(
  uri: string,
  content: string,
  start: number,
  length: number,
): Location {
  return {
    uri,
    range: {
      start: offsetToPosition(content, start),
      end: offsetToPosition(content, start + length),
    },
  };
}

function locationFromFileOffsets(
  fileName: string,
  start: number,
  length: number,
): Location | undefined {
  const resolvedFileName = path.isAbsolute(fileName)
    ? fileName
    : path.resolve(workspaceRoot ?? process.cwd(), fileName);
  const content = ts.sys.readFile(resolvedFileName);
  return content === undefined
    ? undefined
    : locationFromOffsets(
        pathToFileURL(resolvedFileName).toString(),
        content,
        start,
        length,
      );
}

function* getWorkspaceEtaDocuments(): Generator<{
  uri: string;
  source: string;
}> {
  for (const fileName of workspaceEtaFiles) {
    const uri = pathToFileURL(fileName).toString();
    const source = documents.get(uri)?.getText() ?? ts.sys.readFile(fileName);
    if (source !== undefined) yield { uri, source };
  }
}
function getEtaNavigationLocations(
  uri: string,
  source: string,
  options: EtaLanguageOptions,
  offset: number,
): Location[] {
  const pathContext = getTemplatePathContextAtOffset(source, offset, options);
  if (pathContext) {
    try {
      const resolutionOptions = getTemplateResolutionOptionsForUri(uri);
      const target = resolveTemplatePath(pathContext.value, {
        fromFile: fileURLToPath(uri),
        views: resolutionOptions?.views,
        defaultExtension: resolutionOptions?.defaultExtension,
        templateFiles: workspaceEtaFiles,
      });
      if (target) {
        const targetSource = ts.sys.readFile(target) ?? "";
        return [locationFromOffsets(pathToFileURL(target).toString(), targetSource, 0, 0)];
      }
    } catch {
      return [];
    }
  }

  const blockContext = getBlockCallContextAtOffset(source, offset, options);
  if (!blockContext) return [];
  const matches: Array<Location & { declaration: boolean }> = [];
  for (const {
    uri: targetUri,
    source: targetSource,
  } of getWorkspaceEtaDocuments()) {
    const targetOptions = getDocumentLanguageOptions(targetUri);
    for (const candidate of getBlockCallContexts(targetSource, targetOptions)) {
      if (
        candidate.value !== blockContext.value ||
        (targetUri === uri && candidate.valueStart === blockContext.valueStart)
      ) {
        continue;
      }
      matches.push({
        ...locationFromOffsets(
          targetUri,
          targetSource,
          candidate.valueStart,
          candidate.value.length,
        ),
        declaration: candidate.declaration,
      });
    }
  }
  matches.sort((left, right) => Number(right.declaration) - Number(left.declaration));
  return matches.map(({ declaration: _, ...location }) => location);
}

function getTypeScriptDefinitionLocations(
  virtual: VirtualPosition,
): Location[] {
  return (
    getLanguageService()
      .getDefinitionAtPosition(virtual.virtualPath, virtual.virtualOffset)
      ?.flatMap((definition) => {
        const location = locationFromTypeScriptSpan(
          definition.fileName,
          definition.textSpan.start,
          definition.textSpan.length,
        );
        return location ? [location] : [];
      }) ?? []
  );
}

function getInferredDataDefinitionLocations(
  uri: string,
  virtual: VirtualPosition,
): Location[] {
  const dataPath = getEtaDataPathAtPosition(
    virtual.virtualContent,
    virtual.virtualOffset,
    virtual.options,
  );
  if (!dataPath) return [];

  return getDataDefinitionsForUri(uri, dataPath).flatMap((definition) => {
    const location = locationFromFileOffsets(
      definition.fileName,
      definition.start,
      definition.length,
    );
    return location ? [location] : [];
  });
}

connection.onDefinition(
  (params: TextDocumentPositionParams): Location[] | null => {
    const virtual = getVirtualPosition(params);
    if (!virtual) return null;
    const sourceOffset = positionToOffset(
      virtual.docText,
      params.position.line,
      params.position.character,
    );
    const etaLocations = getEtaNavigationLocations(
      params.textDocument.uri,
      virtual.docText,
      virtual.options,
      sourceOffset,
    );
    if (etaLocations.length > 0) return etaLocations;

    const typeScriptLocations = getTypeScriptDefinitionLocations(virtual);
    if (typeScriptLocations.length > 0) return typeScriptLocations;

    const inferredLocations = getInferredDataDefinitionLocations(
      params.textDocument.uri,
      virtual,
    );
    return inferredLocations.length > 0 ? inferredLocations : null;
  },
);

function locationFromTypeScriptSpan(
  fileName: string,
  start: number,
  length: number,
): Location | undefined {
  if (!virtualContents.has(fileName)) {
    return locationFromFileOffsets(fileName, start, length);
  }
  const virtualEntry = [...uriToVirtualPath].find(
    ([, virtualPath]) => virtualPath === fileName,
  );
  if (!virtualEntry) return undefined;
  const [uri] = virtualEntry;
  const document = documents.get(uri);
  const virtualContent = virtualContents.get(fileName);
  if (!document || virtualContent === undefined) return undefined;
  const bodyStart = positionToOffset(
    virtualContent,
    virtualPreambleLines.get(fileName) ?? 0,
    0,
  );
  if (start < bodyStart || start - bodyStart > document.getText().length) {
    return undefined;
  }
  return locationFromOffsets(
    uri,
    document.getText(),
    start - bodyStart,
    length,
  );
}

connection.onReferences((params) => {
  const virtual = getVirtualPosition(params);
  if (!virtual) return [];
  const sourceOffset = positionToOffset(
    virtual.docText,
    params.position.line,
    params.position.character,
  );
  const block = getBlockCallContextAtOffset(
    virtual.docText,
    sourceOffset,
    virtual.options,
  );
  if (block) {
    const locations = getEtaNavigationLocations(
      params.textDocument.uri,
      virtual.docText,
      virtual.options,
      sourceOffset,
    );
    if (params.context.includeDeclaration || !block.declaration) {
      locations.push(
        locationFromOffsets(
          params.textDocument.uri,
          virtual.docText,
          block.valueStart,
          block.value.length,
        ),
      );
    }
    return locations;
  }

  return (
    getLanguageService()
      .getReferencesAtPosition(virtual.virtualPath, virtual.virtualOffset)
      ?.flatMap((reference) => {
        const location = locationFromTypeScriptSpan(
          reference.fileName,
          reference.textSpan.start,
          reference.textSpan.length,
        );
        return location ? [location] : [];
      }) ?? []
  );
});

interface RenameTextEdit {
  range: Location["range"];
  newText: string;
}

type RenameChanges = Record<string, RenameTextEdit[]>;

function appendRenameChange(
  changes: RenameChanges,
  uri: string,
  edit: RenameTextEdit,
): void {
  const edits = changes[uri] ?? [];
  edits.push(edit);
  changes[uri] = edits;
}

function getBlockRenameChanges(blockName: string, newName: string): RenameChanges {
  const changes: RenameChanges = {};
  for (const {
    uri: targetUri,
    source: targetSource,
  } of getWorkspaceEtaDocuments()) {
    for (const candidate of getBlockCallContexts(
      targetSource,
      getDocumentLanguageOptions(targetUri),
    )) {
      if (candidate.value !== blockName) continue;
      appendRenameChange(changes, targetUri, {
        range: locationFromOffsets(
          targetUri,
          targetSource,
          candidate.valueStart,
          candidate.value.length,
        ).range,
        newText: newName,
      });
    }
  }
  return changes;
}

function getTypeScriptRenameChanges(
  virtual: VirtualPosition,
  newName: string,
): RenameChanges {
  const changes: RenameChanges = {};
  const renameLocations = getLanguageService().findRenameLocations(
    virtual.virtualPath,
    virtual.virtualOffset,
    false,
    false,
    {},
  );
  for (const renameLocation of renameLocations ?? []) {
    const location = locationFromTypeScriptSpan(
      renameLocation.fileName,
      renameLocation.textSpan.start,
      renameLocation.textSpan.length,
    );
    if (!location) continue;
    appendRenameChange(changes, location.uri, {
      range: location.range,
      newText: newName,
    });
  }
  return changes;
}

function renameResult(changes: RenameChanges): { changes: RenameChanges } | null {
  return Object.keys(changes).length > 0 ? { changes } : null;
}

connection.onRenameRequest((params) => {
  const virtual = getVirtualPosition(params);
  if (!virtual) return null;
  const sourceOffset = positionToOffset(
    virtual.docText,
    params.position.line,
    params.position.character,
  );
  const block = getBlockCallContextAtOffset(
    virtual.docText,
    sourceOffset,
    virtual.options,
  );
  const changes = block
    ? getBlockRenameChanges(block.value, params.newName)
    : getTypeScriptRenameChanges(virtual, params.newName);
  return renameResult(changes);
});

connection.onSignatureHelp((params) => {
  const virtual = getVirtualPosition(params);
  if (!virtual) return null;
  const help = getLanguageService().getSignatureHelpItems(
    virtual.virtualPath,
    virtual.virtualOffset,
    undefined,
  );
  if (!help) return null;
  return {
    activeSignature: help.selectedItemIndex,
    activeParameter: help.argumentIndex,
    signatures: help.items.map((item) => ({
      label:
        item.prefixDisplayParts.map((part) => part.text).join("") +
        item.parameters
          .map((parameter) =>
            parameter.displayParts.map((part) => part.text).join(""),
          )
          .join(item.separatorDisplayParts.map((part) => part.text).join("")) +
        item.suffixDisplayParts.map((part) => part.text).join(""),
      documentation: item.documentation
        .map((part) => part.text)
        .join("") || undefined,
      parameters: item.parameters.map((parameter) => ({
        label: parameter.displayParts.map((part) => part.text).join(""),
        documentation:
          parameter.documentation.map((part) => part.text).join("") ||
          undefined,
      })),
    })),
  };
});

interface ServerDiagnostic {
  range: Location["range"];
  message: string;
  severity: DiagnosticSeverity;
  source: string;
}

function getUnclosedEtaTagMessage(
  unclosedState: "string" | "block-comment" | undefined,
): string {
  if (unclosedState === "string") return "Unclosed string in Eta tag";
  if (unclosedState === "block-comment") {
    return "Unclosed block comment in Eta tag";
  }
  return "Unclosed Eta tag";
}

function collectEtaDiagnostics(
  uri: string,
  source: string,
  options: EtaLanguageOptions,
): ServerDiagnostic[] {
  const diagnostics: ServerDiagnostic[] = [];
  for (const tag of findEtaTagRanges(source, options)) {
    if (!tag.closed) {
      diagnostics.push({
        range: locationFromOffsets(uri, source, tag.start, tag.end - tag.start)
          .range,
        message: getUnclosedEtaTagMessage(tag.unclosedState),
        severity: DiagnosticSeverity.Error,
        source: "Eta",
      });
    } else if (tag.empty) {
      diagnostics.push({
        range: locationFromOffsets(uri, source, tag.start, tag.end - tag.start)
          .range,
        message: "Empty Eta tag",
        severity: DiagnosticSeverity.Information,
        source: "Eta",
      });
    }
  }
  return diagnostics;
}

function getDiagnosticSeverity(
  category: ts.DiagnosticCategory,
): DiagnosticSeverity {
  if (category === ts.DiagnosticCategory.Error) {
    return DiagnosticSeverity.Error;
  }
  if (category === ts.DiagnosticCategory.Warning) {
    return DiagnosticSeverity.Warning;
  }
  return DiagnosticSeverity.Information;
}

function collectTypeScriptDiagnostics(
  uri: string,
  source: string,
): ServerDiagnostic[] {
  const virtualPath = getVirtualPath(uri);
  const virtualContent = virtualContents.get(virtualPath);
  if (virtualContent === undefined) return [];

  const bodyStart = positionToOffset(
    virtualContent,
    virtualPreambleLines.get(virtualPath) ?? 0,
    0,
  );
  const languageService = getLanguageService();
  const typeScriptDiagnostics = [
    ...languageService.getSyntacticDiagnostics(virtualPath),
    ...languageService.getSemanticDiagnostics(virtualPath),
  ];
  const diagnostics: ServerDiagnostic[] = [];
  for (const diagnostic of typeScriptDiagnostics) {
    if (
      diagnostic.start === undefined ||
      diagnostic.length === undefined ||
      diagnostic.start < bodyStart ||
      diagnostic.start - bodyStart >= source.length
    ) {
      continue;
    }
    diagnostics.push({
      range: locationFromOffsets(
        uri,
        source,
        diagnostic.start - bodyStart,
        diagnostic.length,
      ).range,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      severity: getDiagnosticSeverity(diagnostic.category),
      source: "TypeScript",
    });
  }
  return diagnostics;
}

function publishDiagnostics(uri: string): void {
  const document = documents.get(uri);
  if (!document) return;
  const source = document.getText();
  const diagnostics = [
    ...collectEtaDiagnostics(uri, source, getDocumentLanguageOptions(uri)),
    ...collectTypeScriptDiagnostics(uri, source),
  ];
  connection.sendDiagnostics({ uri, diagnostics });
}

connection.languages.semanticTokens.on((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return { data: [] };
  const source = document.getText();
  const options = getDocumentLanguageOptions(params.textDocument.uri);
  const tokens: Array<{ line: number; character: number; length: number }> = [];
  for (const range of findEtaTagRanges(source, options)) {
    for (const prefix of options.customTags) {
      const token = `${options.tags[0]}${prefix}`;
      if (!source.startsWith(token, range.start)) continue;
      const position = offsetToPosition(source, range.start);
      tokens.push({ ...position, length: token.length });
    }
  }
  tokens.sort(
    (left, right) =>
      left.line - right.line || left.character - right.character,
  );
  let previousLine = 0;
  let previousCharacter = 0;
  const data: number[] = [];
  for (const token of tokens) {
    const deltaLine = token.line - previousLine;
    const deltaCharacter =
      deltaLine === 0 ? token.character - previousCharacter : token.character;
    data.push(deltaLine, deltaCharacter, token.length, 0, 0);
    previousLine = token.line;
    previousCharacter = token.character;
  }
  return { data };
});

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const virtual = getVirtualPosition(params);
  if (!virtual) return null;

  const info = getLanguageService().getQuickInfoAtPosition(
    virtual.virtualPath,
    virtual.virtualOffset,
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
