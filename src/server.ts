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
import {
  buildRuntimeVirtualDocument,
  buildVirtualDocument,
} from "./virtualDocument";
import { getEtaDataPathAtPosition, offsetToPosition } from "./definition";
import { isInsideEtaTagInText, positionToOffset } from "./position";
import { tsKindToLSP } from "./lspKind";
import { createServerLogger } from "./logging";
import {
  ETA_LANGUAGE_SUPPORT_MANIFEST,
  areManifestTemplatesRelated,
  getManifestSymbolAt,
  getManifestTemplate,
  loadEtaLanguageSupportManifest,
  sourceOffsetToVirtual,
  virtualRangeToSource,
  type EtaLanguageSupportManifest,
  type EtaManifestSymbol,
  type EtaManifestTemplate,
  type EtaManifestVirtualDocument,
} from "./etaManifest";
import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
  applyNonDefaultEtaLanguageOptions,
  normalizeEtaLanguageOptions,
} from "./etaConfig";
import { findEtaTagRanges } from "./etaScanner";
import {
  ETA_SEMANTIC_TOKEN_TYPES,
  collectEtaSemanticTokens,
} from "./semanticTokens";
import {
  getBlockCallContextAtOffset,
  getBlockCallContexts,
  getTemplatePathCompletions,
  getTemplatePathContextAtOffset,
  type BlockCallContext,
  type StringCallContext,
} from "./templateContext";
import {
  findMostSpecificContainingRoot,
  isFileWithinRoot,
  resolveTemplatePath,
} from "./templatePaths";
import {
  areEtaTemplatesRelated,
  analyzeWorkspaceFiles,
  getDataDefinitionsForUri,
  getEtaLanguageOptionsForUri,
  getItTypeForUri,
  getTemplateResolutionOptionsForUri,
  getWorkspaceProjectForFile,
  scanWorkspaceFiles,
  templateDataDefinitionMap,
  templateRegistrationMap,
  templateDataTypeMap,
  templateLanguageOptionsMap,
  templateRelationshipMap,
  templateResolutionOptionsMap,
  workspaceEtaFiles,
  workspaceProjects,
  workspaceTsFiles,
  WORKSPACE_SCRIPT_EXTENSIONS,
  type WorkspaceProject,
} from "./typeInference";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analysisLog = createServerLogger(connection.console, "analysis");
const documentLog = createServerLogger(connection.console, "document");
const virtualLog = createServerLogger(connection.console, "virtual");

const virtualContents = new Map<string, string>(); // virtualPath -> content
const uriToVirtualPath = new Map<string, string>(); // uri -> virtualPath
const virtualDocuments = new Map<string, EtaManifestVirtualDocument>();
const workspaceManifests = new Map<string, EtaLanguageSupportManifest>();
const manifestTemplateCache = new Map<
  string,
  {
    manifest: EtaLanguageSupportManifest;
    source: string;
    template: EtaManifestTemplate | undefined;
  }
>();

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
function canonicalExistingPath(fileName: string): string {
  try {
    return ts.sys.realpath?.(fileName) ?? fileName;
  } catch {
    return fileName;
  }
}

function getWorkspaceManifestForFile(
  fileName: string,
): EtaLanguageSupportManifest | undefined {
  return findMostSpecificContainingRoot(
    canonicalExistingPath(fileName),
    workspaceManifests.values(),
  );
}

function getFreshManifestForUri(
  uri: string,
  source?: string,
): EtaLanguageSupportManifest | undefined {
  if (!getFreshManifestTemplate(uri, source)) return undefined;
  try {
    return getWorkspaceManifestForFile(
      canonicalExistingPath(fileURLToPath(uri)),
    );
  } catch {
    return undefined;
  }
}

function locationFromManifestLocation(
  manifest: EtaLanguageSupportManifest,
  location: { fileName: string; start: number; length: number },
): Location | undefined {
  if (!isFileWithinRoot(location.fileName, manifest.root)) return undefined;
  return locationFromFileOffsets(
    location.fileName,
    location.start,
    location.length,
  );
}

function getManifestSymbolContext(
  uri: string,
  source: string,
  offset: number,
):
  | { manifest: EtaLanguageSupportManifest; symbol: EtaManifestSymbol }
  | undefined {
  const manifest = getFreshManifestForUri(uri, source);
  if (!manifest) return undefined;
  try {
    const symbol = getManifestSymbolAt(
      manifest,
      canonicalExistingPath(fileURLToPath(uri)),
      offset,
    );
    return symbol ? { manifest, symbol } : undefined;
  } catch {
    return undefined;
  }
}

function getFreshManifestTemplate(
  uri: string,
  source?: string,
): EtaManifestTemplate | undefined {
  try {
    const fileName = canonicalExistingPath(fileURLToPath(uri));
    const manifest = getWorkspaceManifestForFile(fileName);
    if (!manifest) {
      manifestTemplateCache.delete(uri);
      return undefined;
    }
    const currentSource =
      source ?? documents.get(uri)?.getText() ?? ts.sys.readFile(fileName);
    if (currentSource === undefined) return undefined;
    const cached = manifestTemplateCache.get(uri);
    if (cached?.manifest === manifest && cached.source === currentSource) {
      return cached.template;
    }
    const template = getManifestTemplate(manifest, fileName, currentSource);
    manifestTemplateCache.set(uri, {
      manifest,
      source: currentSource,
      template,
    });
    return template;
  } catch {
    manifestTemplateCache.delete(uri);
    return undefined;
  }
}

function reloadWorkspaceManifests(): void {
  manifestTemplateCache.clear();
  workspaceManifests.clear();
  for (const root of workspaceRoots) {
    const result = loadEtaLanguageSupportManifest(root);
    if (result.status === "loaded") {
      workspaceManifests.set(result.manifest.root, result.manifest);
      analysisLog.info(
        `Loaded ${ETA_LANGUAGE_SUPPORT_MANIFEST} (${result.manifest.templates.size} templates)`,
      );
    } else if (result.status !== "missing") {
      for (const message of result.messages) {
        analysisLog.warn(`${ETA_LANGUAGE_SUPPORT_MANIFEST}: ${message}`);
      }
    }
  }
}

function refreshWorkspaceFiles(): void {
  workspaceTsFiles.clear();
  workspaceEtaFiles.clear();
  workspaceProjects.length = 0;
  workspaceRoot = workspaceRoots[0];
  for (const root of workspaceRoots) scanWorkspaceFiles(root);
  activeWorkspaceProject = undefined;
  languageService?.dispose();
  languageService = null;
}

function ensureWorkspaceAnalyzed(): void {
  if (workspaceAnalyzed) return;
  workspaceAnalyzed = true;
  runWorkspaceAnalysis();
}

function runWorkspaceAnalysis(): void {
  templateDataTypeMap.clear();
  templateRegistrationMap.clear();
  templateDataDefinitionMap.clear();
  templateLanguageOptionsMap.clear();
  templateResolutionOptionsMap.clear();
  templateRelationshipMap.clear();
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
            `${path.basename(fileName)}: "${key}" inferred (${value.length} characters)`,
          );
        },
      },
      workspaceProjects,
    );
  }

  analysisLog.info(
    `Complete - map entries: [${[...templateDataTypeMap.keys()].join(", ")}]`,
  );
  for (const [key, value] of templateDataTypeMap) {
    analysisLog.debug(`"${key}" inferred (${value.length} characters)`);
  }

  reloadWorkspaceManifests();

  rebuildOpenVirtualFiles();
}

function getDocumentLanguageOptions(uri: string): EtaLanguageOptions {
  const manifestOptions = getFreshManifestTemplate(uri)?.options;
  if (manifestOptions) return manifestOptions;
  const inferredOptions =
    getEtaLanguageOptionsForUri(uri) ?? DEFAULT_ETA_LANGUAGE_OPTIONS;
  return applyNonDefaultEtaLanguageOptions(
    inferredOptions,
    etaLanguageOptions,
  );
}

function getDocumentResolutionOptions(uri: string) {
  return (
    getFreshManifestTemplate(uri)?.resolution ??
    getTemplateResolutionOptionsForUri(uri)
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
  return WORKSPACE_SCRIPT_EXTENSIONS.includes(
    path.extname(fsPath) as (typeof WORKSPACE_SCRIPT_EXTENSIONS)[number],
  );
}

function isWorkspaceConfigFile(fsPath: string): boolean {
  const basename = path.basename(fsPath).toLowerCase();
  return (
    basename === "tsconfig.json" ||
    basename === "jsconfig.json" ||
    basename === ETA_LANGUAGE_SUPPORT_MANIFEST
  );
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
  const manifestTemplate = getFreshManifestTemplate(uri, etaSource);
  const itType = getItTypeForUri(uri);
  const options = manifestTemplate?.options ?? getDocumentLanguageOptions(uri);
  let virtualDocument: EtaManifestVirtualDocument;
  if (manifestTemplate) {
    virtualDocument = manifestTemplate.virtualDocument;
  } else {
    const built = buildVirtualDocument(etaSource, itType, options);
    const virtualBodyStart = positionToOffset(
      built.content,
      built.preambleLineCount,
      0,
    );
    const mappings =
      etaSource.length > 0
        ? [
            {
              sourceStart: 0,
              sourceLength: etaSource.length,
              virtualStart: virtualBodyStart,
              virtualLength: etaSource.length,
            },
          ]
        : [];
    virtualDocument = {
      content: built.content,
      mappings,
      mappingsByVirtual: mappings,
    };
  }
  virtualDocuments.set(virtualPath, virtualDocument);

  if (virtualContents.get(virtualPath) !== virtualDocument.content) {
    virtualContents.set(virtualPath, virtualDocument.content);
    serviceVersion++;
    try {
      const source = manifestTemplate ? "manifest" : "static analysis";
      virtualLog.debug(
        `${path.basename(fileURLToPath(uri))}: virtual document from ${source}`,
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
  workspaceRoots.length = 0;
  for (const rootUri of params.workspaceFolders?.map((folder) => folder.uri) ?? []) {
    try {
      workspaceRoots.push(fileURLToPath(rootUri));
    } catch {
      // Ignore workspace folders whose URI cannot be resolved locally.
    }
  }
  refreshWorkspaceFiles();
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
        legend: { tokenTypes: [...ETA_SEMANTIC_TOKEN_TYPES], tokenModifiers: [] },
        full: true,
      },
      workspace: {
        workspaceFolders: {
          supported: true,
          changeNotifications: true,
        },
      },
    },
  };
});
connection.onInitialized?.(() => {
  connection.workspace.onDidChangeWorkspaceFolders((event) => {
    let changed = false;
    for (const removed of event.removed) {
      try {
        const root = fileURLToPath(removed.uri);
        const index = workspaceRoots.findIndex(
          (candidate) => path.resolve(candidate) === path.resolve(root),
        );
        if (index >= 0) {
          workspaceRoots.splice(index, 1);
          changed = true;
        }
      } catch {
        // Ignore workspace folders whose URI cannot be resolved locally.
      }
    }
    for (const added of event.added) {
      try {
        const root = fileURLToPath(added.uri);
        if (!workspaceRoots.some((candidate) => path.resolve(candidate) === path.resolve(root))) {
          workspaceRoots.push(root);
          changed = true;
        }
      } catch {
        // Ignore workspace folders whose URI cannot be resolved locally.
      }
    }
    if (changed) {
      refreshWorkspaceFiles();
      workspaceAnalyzed = true;
      runWorkspaceAnalysis();
    }
  });
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
documents.onDidClose?.((event) => {
  const virtualPath = uriToVirtualPath.get(event.document.uri);
  if (virtualPath) {
    virtualContents.delete(virtualPath);
    virtualDocuments.delete(virtualPath);
    manifestTemplateCache.delete(event.document.uri);
    uriToVirtualPath.delete(event.document.uri);
    serviceVersion++;
  }
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
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
  if (configChanged) refreshWorkspaceFiles();
  if (needsReanalysis) runWorkspaceAnalysis();
});

interface VirtualPosition {
  docText: string;
  options: EtaLanguageOptions;
  sourceOffset: number;
  virtualContent: string;
  virtualOffset: number;
  virtualPath: string;
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
  const sourceOffset = positionToOffset(
    docText,
    params.position.line,
    params.position.character,
  );
  const sourceMap = virtualDocuments.get(virtualPath);
  const virtualOffset = sourceMap
    ? sourceOffsetToVirtual(sourceMap, sourceOffset)
    : undefined;
  if (virtualOffset === undefined) return undefined;
  return {
    docText,
    options,
    sourceOffset,
    virtualContent,
    virtualOffset,
    virtualPath,
  };
}

connection.onCompletion((params: TextDocumentPositionParams) => {
  const virtual = getVirtualPosition(params);
  if (!virtual) return [];
  const sourceOffset = virtual.sourceOffset;
  const pathContext = getTemplatePathContextAtOffset(
    virtual.docText,
    sourceOffset,
    virtual.options,
  );
  if (pathContext) {
    try {
      const resolutionOptions = getDocumentResolutionOptions(
        params.textDocument.uri,
      );
      const manifest = getFreshManifestForUri(
        params.textDocument.uri,
        virtual.docText,
      );
      const registeredNames =
        manifest?.templateNames.keys() ?? templateRegistrationMap.keys();
      return getTemplatePathCompletions(
        fileURLToPath(params.textDocument.uri),
        pathContext.value,
        workspaceEtaFiles,
        resolutionOptions?.views,
        registeredNames,
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

function areTemplateUrisRelated(leftUri: string, rightUri: string): boolean {
  try {
    const leftPath = canonicalExistingPath(fileURLToPath(leftUri));
    const rightPath = canonicalExistingPath(fileURLToPath(rightUri));
    const manifest = getFreshManifestForUri(leftUri);
    if (
      manifest &&
      getFreshManifestForUri(rightUri) === manifest &&
      (manifest.templates.has(leftPath) || manifest.templates.has(rightPath))
    ) {
      return areManifestTemplatesRelated(manifest, leftPath, rightPath);
    }
    return areEtaTemplatesRelated(leftPath, rightPath);
  } catch {
    return leftUri === rightUri;
  }
}

function getResolvedTemplatePathLocations(
  uri: string,
  templateName: string,
): Location[] | undefined {
  try {
    const resolutionOptions = getDocumentResolutionOptions(uri);
    const target = resolveTemplatePath(templateName, {
      fromFile: fileURLToPath(uri),
      views: resolutionOptions?.views,
      defaultExtension: resolutionOptions?.defaultExtension,
      templateFiles: workspaceEtaFiles,
    });
    if (!target) return undefined;
    const targetSource = ts.sys.readFile(target) ?? "";
    return [
      locationFromOffsets(
        pathToFileURL(target).toString(),
        targetSource,
        0,
        0,
      ),
    ];
  } catch {
    return [];
  }
}

function getManifestTemplateNameLocations(
  uri: string,
  source: string,
  templateName: string,
): Location[] | undefined {
  const manifest = getFreshManifestForUri(uri, source);
  if (!manifest) return undefined;
  const manifestName = manifest.templateNames.get(templateName);
  if (!manifestName) return undefined;
  const manifestLocation = manifestName.definition ?? {
    fileName: manifestName.fileName,
    start: 0,
    length: 0,
  };
  const location = locationFromManifestLocation(manifest, manifestLocation);
  return location ? [location] : [];
}

function getRegisteredTemplateLocations(
  templateName: string,
): Location[] | undefined {
  const registrations = templateRegistrationMap.get(templateName);
  if (!registrations?.length) return undefined;
  return registrations.flatMap((registration) => {
    const location = locationFromFileOffsets(
      registration.fileName,
      registration.start,
      registration.length,
    );
    return location ? [location] : [];
  });
}

function getTemplatePathNavigationLocations(
  uri: string,
  source: string,
  context: StringCallContext,
): Location[] | undefined {
  return (
    getResolvedTemplatePathLocations(uri, context.value) ??
    getManifestTemplateNameLocations(uri, source, context.value) ??
    getRegisteredTemplateLocations(context.value)
  );
}

function isMatchingBlockCandidate(
  candidate: BlockCallContext,
  selected: BlockCallContext,
  sourceUri: string,
  targetUri: string,
): boolean {
  return (
    candidate.value === selected.value &&
    (targetUri !== sourceUri || candidate.valueStart !== selected.valueStart)
  );
}

function getBlockNavigationLocations(
  uri: string,
  blockContext: BlockCallContext,
): Location[] {
  const matches: Array<Location & { declaration: boolean }> = [];
  for (const {
    uri: targetUri,
    source: targetSource,
  } of getWorkspaceEtaDocuments()) {
    if (!areTemplateUrisRelated(uri, targetUri)) continue;
    const targetOptions = getDocumentLanguageOptions(targetUri);
    for (const candidate of getBlockCallContexts(targetSource, targetOptions)) {
      if (!isMatchingBlockCandidate(candidate, blockContext, uri, targetUri)) {
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
  matches.sort(
    (left, right) => Number(right.declaration) - Number(left.declaration),
  );
  return matches.map(({ declaration: _, ...location }) => location);
}

function getEtaNavigationLocations(
  uri: string,
  source: string,
  options: EtaLanguageOptions,
  offset: number,
): Location[] {
  const pathContext = getTemplatePathContextAtOffset(source, offset, options);
  let pathLocations: Location[] | undefined;
  if (pathContext) {
    pathLocations = getTemplatePathNavigationLocations(
      uri,
      source,
      pathContext,
    );
  }
  if (pathLocations !== undefined) return pathLocations;

  const blockContext = getBlockCallContextAtOffset(source, offset, options);
  if (!blockContext) return [];
  return getBlockNavigationLocations(uri, blockContext);
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

function getManifestSymbolLocations(
  context: {
    manifest: EtaLanguageSupportManifest;
    symbol: EtaManifestSymbol;
  },
  includeDefinitions: boolean,
): Location[] {
  return context.symbol.occurrences.flatMap((occurrence) => {
    if (!includeDefinitions && occurrence.role === "definition") return [];
    const location = locationFromManifestLocation(
      context.manifest,
      occurrence,
    );
    return location ? [location] : [];
  });
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
  const manifest = getFreshManifestForUri(uri, virtual.docText);
  const manifestTemplate = getFreshManifestTemplate(uri, virtual.docText);
  if (manifest && manifestTemplate) {
    const pathKey = JSON.stringify(dataPath);
    return manifestTemplate.dataDefinitions.flatMap((definition) => {
      if (JSON.stringify(definition.dataPath) !== pathKey) return [];
      const location = locationFromManifestLocation(manifest, definition);
      return location ? [location] : [];
    });
  }

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
    const sourceOffset = virtual.sourceOffset;
    const manifestSymbol = getManifestSymbolContext(
      params.textDocument.uri,
      virtual.docText,
      sourceOffset,
    );
    if (manifestSymbol) {
      const manifestLocations = manifestSymbol.symbol.occurrences
        .filter((occurrence) => occurrence.role === "definition")
        .flatMap((occurrence) => {
          const location = locationFromManifestLocation(
            manifestSymbol.manifest,
            occurrence,
          );
          return location ? [location] : [];
        });
      if (manifestLocations.length > 0) return manifestLocations;
    }

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
  const sourceMap = virtualDocuments.get(fileName);
  if (!document || !sourceMap) return undefined;
  const sourceRange = virtualRangeToSource(sourceMap, start, length);
  if (!sourceRange) return undefined;
  return locationFromOffsets(
    uri,
    document.getText(),
    sourceRange.start,
    sourceRange.length,
  );
}

connection.onReferences((params) => {
  const virtual = getVirtualPosition(params);
  if (!virtual) return [];
  const sourceOffset = virtual.sourceOffset;
  const manifestSymbol = getManifestSymbolContext(
    params.textDocument.uri,
    virtual.docText,
    sourceOffset,
  );
  if (manifestSymbol) {
    return getManifestSymbolLocations(
      manifestSymbol,
      params.context.includeDeclaration,
    );
  }

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
function getManifestRenameChanges(
  context: {
    manifest: EtaLanguageSupportManifest;
    symbol: EtaManifestSymbol;
  },
  newName: string,
): RenameChanges {
  const changes: RenameChanges = {};
  for (const location of getManifestSymbolLocations(context, true)) {
    appendRenameChange(changes, location.uri, {
      range: location.range,
      newText: newName,
    });
  }
  return changes;
}

function getBlockRenameChanges(
  sourceUri: string,
  blockName: string,
  newName: string,
): RenameChanges {
  const changes: RenameChanges = {};
  for (const {
    uri: targetUri,
    source: targetSource,
  } of getWorkspaceEtaDocuments()) {
    if (!areTemplateUrisRelated(sourceUri, targetUri)) continue;
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
  const sourceOffset = virtual.sourceOffset;
  const manifestSymbol = getManifestSymbolContext(
    params.textDocument.uri,
    virtual.docText,
    sourceOffset,
  );
  if (manifestSymbol) {
    return renameResult(
      getManifestRenameChanges(manifestSymbol, params.newName),
    );
  }

  const block = getBlockCallContextAtOffset(
    virtual.docText,
    sourceOffset,
    virtual.options,
  );
  const changes = block
    ? getBlockRenameChanges(params.textDocument.uri, block.value, params.newName)
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

function collectManifestDiagnostics(
  uri: string,
  source: string,
): ServerDiagnostic[] {
  const template = getFreshManifestTemplate(uri, source);
  if (!template) return [];
  const severity = {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    information: DiagnosticSeverity.Information,
    hint: DiagnosticSeverity.Hint,
  } as const;
  return template.diagnostics.map((diagnostic) => ({
    range: locationFromOffsets(
      uri,
      source,
      diagnostic.start,
      diagnostic.length,
    ).range,
    message: diagnostic.message,
    severity: severity[diagnostic.severity],
    source: diagnostic.source,
  }));
}

function collectTypeScriptDiagnostics(
  uri: string,
  source: string,
): ServerDiagnostic[] {
  const virtualPath = getVirtualPath(uri);
  const sourceMap = virtualDocuments.get(virtualPath);
  if (!sourceMap) return [];
  const languageService = getLanguageService();
  const typeScriptDiagnostics = [
    ...languageService.getSyntacticDiagnostics(virtualPath),
    ...languageService.getSemanticDiagnostics(virtualPath),
  ];
  const diagnostics: ServerDiagnostic[] = [];
  for (const diagnostic of typeScriptDiagnostics) {
    if (
      diagnostic.start === undefined ||
      diagnostic.length === undefined
    ) {
      continue;
    }
    const sourceRange = virtualRangeToSource(
      sourceMap,
      diagnostic.start,
      diagnostic.length,
    );
    if (!sourceRange) continue;
    diagnostics.push({
      range: locationFromOffsets(
        uri,
        source,
        sourceRange.start,
        sourceRange.length,
      ).range,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      severity: getDiagnosticSeverity(diagnostic.category),
      source: "TypeScript",
    });
  }
  return diagnostics;
}
function collectRuntimeJavaScriptDiagnostics(
  uri: string,
  source: string,
  options: EtaLanguageOptions,
): ServerDiagnostic[] {
  const virtual = buildRuntimeVirtualDocument(source, options);
  const bodyStart = positionToOffset(
    virtual.content,
    virtual.preambleLineCount,
    0,
  );
  const result = ts.transpileModule(virtual.content, {
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "eta-template.js",
    reportDiagnostics: true,
  });
  return (result.diagnostics ?? []).flatMap((diagnostic) => {
    if (
      diagnostic.start === undefined ||
      diagnostic.length === undefined ||
      diagnostic.start < bodyStart ||
      diagnostic.start - bodyStart >= source.length
    ) {
      return [];
    }
    return [
      {
        range: locationFromOffsets(
          uri,
          source,
          diagnostic.start - bodyStart,
          diagnostic.length,
        ).range,
        message: ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n",
        ),
        severity: getDiagnosticSeverity(diagnostic.category),
        source: "JavaScript",
      },
    ];
  });
}

function publishDiagnostics(uri: string): void {
  const document = documents.get(uri);
  if (!document) return;
  const source = document.getText();
  const options = getDocumentLanguageOptions(uri);
  const manifestTemplate = getFreshManifestTemplate(uri, source);
  const diagnostics = [
    ...collectEtaDiagnostics(uri, source, options),
    ...collectTypeScriptDiagnostics(uri, source),
    ...collectManifestDiagnostics(uri, source),
    ...(manifestTemplate
      ? []
      : collectRuntimeJavaScriptDiagnostics(uri, source, options)),
  ];
  connection.sendDiagnostics({ uri, diagnostics });
}

connection.languages.semanticTokens.on((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return { data: [] };
  const source = document.getText();
  const options = getDocumentLanguageOptions(params.textDocument.uri);
  const virtualPath = getVirtualPath(params.textDocument.uri);
  activateWorkspaceProject(params.textDocument.uri);
  updateVirtualFile(params.textDocument.uri, source);
  const virtualDocument = virtualDocuments.get(virtualPath);
  if (!virtualDocument) return { data: [] };

  const tokens = collectEtaSemanticTokens(
    getLanguageService(),
    virtualPath,
    virtualDocument,
    source,
    options,
  ).flatMap((token) => {
    const parts: Array<{
      line: number;
      character: number;
      length: number;
      tokenType: number;
    }> = [];
    const end = token.start + token.length;
    let start = token.start;
    while (start < end) {
      const newline = source.indexOf("\n", start);
      const physicalEnd = newline < 0 || newline >= end ? end : newline;
      const lineEnd =
        physicalEnd > start && source[physicalEnd - 1] === "\r"
          ? physicalEnd - 1
          : physicalEnd;
      if (lineEnd > start) {
        parts.push({
          ...offsetToPosition(source, start),
          length: lineEnd - start,
          tokenType: token.tokenType,
        });
      }
      if (newline < 0 || newline >= end) break;
      start = newline + 1;
    }
    return parts;
  });
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
    data.push(
      deltaLine,
      deltaCharacter,
      token.length,
      token.tokenType,
      0,
    );
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
