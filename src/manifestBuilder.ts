import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as ts from "typescript";
import { execFileSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ETA_LANGUAGE_SUPPORT_MANIFEST,
  MAX_MANIFEST_BYTES,
  sha256Text,
  validateEtaLanguageSupportManifest,
} from "./etaManifest";
import { normalizeEtaLanguageOptions, type EtaLanguageOptions } from "./etaConfig";
import { typeToStructuralString } from "./typeInference";
import { buildVirtualDocument } from "./virtualDocument";

type ManifestLocation = { path: string; start: number; length: number };
type ManifestMapping = {
  sourceStart: number;
  sourceLength: number;
  virtualStart: number;
  virtualLength: number;
};
type ManifestVirtualDocument = { content: string; mappings: ManifestMapping[] };
type ManifestDiagnostic = {
  start: number;
  length: number;
  severity: "error" | "warning" | "information" | "hint";
  source: string;
  message: string;
};

export interface EtaManifestTypeReference {
  file: string;
  export: string;
  config?: string;
}

export interface EtaManifestTemplateOptions {
  path: string;
  source?: string;
  /** Required before replacing a different existing generated file. */
  overwriteGenerated?: boolean;
  dataType: string | EtaManifestTypeReference;
  eta?: unknown;
  views?: string;
  defaultExtension?: string;
  names?: readonly (string | { name: string; definition?: ManifestLocation })[];
  relationships?: readonly string[];
  dataDefinitions?: readonly { dataPath: readonly string[]; location: ManifestLocation }[];
  diagnostics?: readonly ManifestDiagnostic[];
  symbols?: readonly { id: string; occurrences: readonly (ManifestLocation & { role: "definition" | "reference" })[] }[];
  virtualDocument?: ManifestVirtualDocument;
  transformed?: boolean;
}

export interface EtaManifestBuilderOptions {
  root?: string;
  output?: string;
  inputs?: readonly string[];
}

interface PendingTemplate {
  path: string;
  source: string;
  dataType: string;
  options: EtaLanguageOptions;
  views?: string;
  defaultExtension: string;
  names: readonly (string | { name: string; definition?: ManifestLocation })[];
  relationships: readonly string[];
  dataDefinitions: readonly { dataPath: readonly string[]; location: ManifestLocation }[];
  diagnostics: readonly ManifestDiagnostic[];
  symbols: readonly { id: string; occurrences: readonly (ManifestLocation & { role: "definition" | "reference" })[] }[];
  virtualDocument: ManifestVirtualDocument;
}

function canonical(fileName: string): string {
  const normalized = path.normalize(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function existingRealPath(fileName: string, label: string): string {
  try {
    return fs.realpathSync.native(fileName);
  } catch {
    throw new Error(`${label} must exist: ${fileName}`);
  }
}

function containedExistingFile(root: string, fileName: string, label: string): string {
  const absolute = path.resolve(fileName);
  if (!isWithin(root, absolute)) throw new Error(`${label} must be inside the workspace root`);
  const real = existingRealPath(absolute, label);
  if (!isWithin(root, real) || !fs.statSync(real).isFile()) {
    throw new Error(`${label} must be a workspace file`);
  }
  return real;
}

function containedExistingDirectory(root: string, fileName: string, label: string): string {
  const absolute = path.resolve(fileName);
  if (!isWithin(root, absolute)) throw new Error(`${label} must be inside the workspace root`);
  const real = existingRealPath(absolute, label);
  if (!isWithin(root, real) || !fs.statSync(real).isDirectory()) {
    throw new Error(`${label} must be a workspace directory`);
  }
  return real;
}

function sortByPath<T extends { path: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => compareText(left.path, right.path));
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function cloneOptions(value: EtaLanguageOptions): EtaLanguageOptions {
  return {
    ...value,
    tags: [...value.tags],
    parse: { ...value.parse },
    customTags: [...value.customTags],
    customTagTypes: { ...value.customTagTypes },
    autoTrim: Array.isArray(value.autoTrim) ? [...value.autoTrim] as [false | "nl" | "slurp", false | "nl" | "slurp"] : value.autoTrim,
  };
}

function languageOptions(eta: unknown): EtaLanguageOptions {
  const candidate = eta && typeof eta === "object" && "config" in eta
    ? (eta as { config: unknown }).config
    : eta;
  const config = candidate && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : {};
  const customTags = config.customTags;
  const customTagNames = customTags && typeof customTags === "object" && !Array.isArray(customTags)
    ? Object.keys(customTags)
    : customTags;
  return cloneOptions(normalizeEtaLanguageOptions({ ...config, customTags: customTagNames }));
}

function etaConfig(eta: unknown): Record<string, unknown> {
  const candidate = eta && typeof eta === "object" && "config" in eta
    ? (eta as { config: unknown }).config
    : eta;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
}

function configuredResolution(
  root: string,
  specification: EtaManifestTemplateOptions,
): { views?: string; defaultExtension: string } {
  const config = etaConfig(specification.eta);
  const configuredViews = config.views;
  const viewsValue = specification.views ?? configuredViews;
  if (viewsValue !== undefined && typeof viewsValue !== "string") throw new Error("Eta views must be a string path");
  if (specification.views === undefined && typeof configuredViews === "string" && !path.isAbsolute(configuredViews)) {
    throw new Error("Relative Eta config.views requires an explicit template views path");
  }
  const views = viewsValue === undefined
    ? undefined
    : containedExistingDirectory(root, path.resolve(root, viewsValue), "Eta views");
  const configuredExtension = config.defaultExtension;
  const defaultExtension = specification.defaultExtension ?? (
    typeof configuredExtension === "string" ? configuredExtension : ".eta"
  );
  return { views: views ? path.relative(root, views).split(path.sep).join("/") : undefined, defaultExtension };
}

function readJsonConfig(fileName: string): ts.ParsedCommandLine | undefined {
  if (!fs.existsSync(fileName)) return undefined;
  const result = ts.readConfigFile(fileName, ts.sys.readFile);
  if (result.error) throw new Error(ts.flattenDiagnosticMessageText(result.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(result.config, ts.sys, path.dirname(fileName), undefined, fileName);
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: (value) => value,
      getCurrentDirectory: () => path.dirname(fileName),
      getNewLine: () => "\n",
    }));
  }
  return parsed;
}

function compilerOptionsFor(configFile: string): ts.CompilerOptions {
  const requested = configFile;
  return readJsonConfig(requested)?.options ?? {
    strict: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
}

function resolveExtendsPath(root: string, configFile: string, extendsValue: string): string {
  let candidate: string;
  if (extendsValue.startsWith(".") || path.isAbsolute(extendsValue)) {
    const requested = extendsValue.endsWith(".json") ? extendsValue : `${extendsValue}.json`;
    candidate = path.resolve(path.dirname(configFile), requested);
  } else {
    candidate = require.resolve(extendsValue, { paths: [path.dirname(configFile)] });
  }
  return containedExistingFile(root, candidate, "tsconfig extends");
}

function fileHash(fileName: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(fileName)).digest("hex");
}

function snapshotInput(inputs: Map<string, string>, fileName: string): void {
  inputs.set(fileName, fileHash(fileName));
}

function trackPackageInputs(root: string, from: string, inputs: Map<string, string>): void {
  for (let directory = path.dirname(from); isWithin(root, directory); directory = path.dirname(directory)) {
    for (const name of ["package.json", "package-lock.json", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) snapshotInput(inputs, fs.realpathSync.native(candidate));
    }
    if (directory === root) break;
  }
}

function trackConfigInputs(root: string, fileName: string, inputs: Map<string, string>, seen = new Set<string>()): void {
  const absolute = containedExistingFile(root, fileName, "tsconfig");
  if (seen.has(canonical(absolute))) return;
  seen.add(canonical(absolute));
  snapshotInput(inputs, absolute);
  trackPackageInputs(root, absolute, inputs);
  const parsed = ts.readConfigFile(absolute, ts.sys.readFile);
  if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  const raw: unknown = parsed.config;
  const extendsValue = raw && typeof raw === "object" ? (raw as { extends?: unknown }).extends : undefined;
  let bases: unknown[] = [];
  if (typeof extendsValue === "string") bases = [extendsValue];
  else if (Array.isArray(extendsValue)) bases = extendsValue;
  for (const base of bases) {
    if (typeof base !== "string") throw new Error("tsconfig extends entries must be strings");
    trackConfigInputs(root, resolveExtendsPath(root, absolute, base), inputs, seen);
  }
}

function hasTransformingPlugins(eta: unknown): boolean {
  const candidate = eta && typeof eta === "object" && "config" in eta
    ? (eta as { config: unknown }).config
    : eta;
  if (!candidate || typeof candidate !== "object") return false;
  const plugins = (candidate as { plugins?: unknown }).plugins;
  return Array.isArray(plugins) ? plugins.length > 0 : Boolean(plugins);
}

function isTypeScriptLibrary(options: ts.CompilerOptions, fileName: string): boolean {
  const libraryDirectory = path.dirname(ts.getDefaultLibFilePath(options));
  return canonical(path.dirname(fileName)) === canonical(libraryDirectory);
}

function isProjectModelFile(root: string, fileName: string): boolean {
  return isWithin(root, fileName);
}

function reportModelErrors(program: ts.Program, root: string): void {
  const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
    diagnostic.category === ts.DiagnosticCategory.Error &&
    (!diagnostic.file || isProjectModelFile(root, diagnostic.file.fileName)),
  );
  if (errors.length > 0) throw new Error(ts.flattenDiagnosticMessageText(errors[0].messageText, "\n"));
}

function structuralType(root: string, reference: EtaManifestTypeReference, inputFiles: Map<string, string>): string {
  const fileName = containedExistingFile(root, path.resolve(root, reference.file), "Type model");
  const requestedConfig = path.resolve(root, reference.config ?? "tsconfig.json");
  const configFile = fs.existsSync(requestedConfig)
    ? containedExistingFile(root, requestedConfig, "tsconfig")
    : undefined;
  if (configFile) trackConfigInputs(root, configFile, inputFiles);
  const options = configFile ? compilerOptionsFor(configFile) : {
    strict: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const program = ts.createProgram([fileName], options);
  reportModelErrors(program, root);
  const checker = program.getTypeChecker();
  for (const source of program.getSourceFiles()) {
    if (isTypeScriptLibrary(options, source.fileName)) continue;
    const realSource = existingRealPath(source.fileName, "Type model dependency");
    if (!isWithin(root, realSource)) throw new Error(`Type model dependency resolves outside the workspace root: ${source.fileName}`);
    snapshotInput(inputFiles, realSource);
  }
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`Unable to read type model ${reference.file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const exported = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((item) => item.name === reference.export)
    : undefined;
  const symbol = exported && (exported.flags & ts.SymbolFlags.Alias)
    ? checker.getAliasedSymbol(exported)
    : exported;
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration) throw new Error(`Export ${reference.export} was not found in ${reference.file}`);
  const isTypeOnly = ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration);
  const type = isTypeOnly
    ? checker.getDeclaredTypeOfSymbol(symbol)
    : checker.getTypeOfSymbolAtLocation(symbol, declaration);
  return typeToStructuralString(checker, type);
}

/** Builds an extension-readable manifest without letting the extension execute project code. */
export class EtaManifestBuilder {
  readonly root: string;
  readonly output: string;
  private readonly inputFiles = new Map<string, string>();
  private readonly templates: PendingTemplate[] = [];

  constructor(options: EtaManifestBuilderOptions = {}) {
    const requestedRoot = options.root ?? process.cwd();
    this.root = fs.realpathSync.native(requestedRoot);
    this.output = path.resolve(this.root, options.output ?? ETA_LANGUAGE_SUPPORT_MANIFEST);
    if (!isWithin(this.root, this.output)) throw new Error("Manifest output must be inside the workspace root");
    this.assertSafeOutputTarget(this.output);
    for (const input of options.inputs ?? []) this.addInput(input);
  }

  addInput(fileName: string): this {
    const absolute = path.resolve(this.root, fileName);
    this.assertNotOutputFile(absolute, "an input");
    if (!isWithin(this.root, absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`Manifest input must be an existing workspace file: ${fileName}`);
    }
    const realInput = fs.realpathSync.native(absolute);
    if (!isWithin(this.root, realInput)) throw new Error(`Manifest input resolves outside the workspace root: ${fileName}`);
    snapshotInput(this.inputFiles, realInput);
    return this;
  }

  addTemplate(specification: EtaManifestTemplateOptions): this {
    const absolute = path.resolve(this.root, specification.path);
    if (!isWithin(this.root, absolute)) throw new Error("Template path must be inside the workspace root");
    this.assertNotOutputFile(absolute, "a template");
    if (fs.existsSync(absolute) && !isWithin(this.root, fs.realpathSync.native(absolute))) {
      throw new Error("Template path resolves outside the workspace root");
    }
    const source = this.readTemplateSource(absolute, specification);
    const realFile = fs.realpathSync.native(absolute);
    if (!isWithin(this.root, realFile)) throw new Error("Template resolves outside the workspace root");
    this.registerMetadataInputs(specification);
    const dataType = typeof specification.dataType === "string"
      ? specification.dataType
      : structuralType(this.root, specification.dataType, this.inputFiles);
    const options = languageOptions(specification.eta);
    const resolution = configuredResolution(this.root, specification);
    const built = buildVirtualDocument(source, dataType, options);
    if ((specification.transformed || hasTransformingPlugins(specification.eta)) && !specification.virtualDocument) {
      throw new Error("Transformed templates require explicit virtualDocument content and mappings");
    }
    const virtualDocument = specification.virtualDocument ?? {
      content: built.content,
      mappings: source.length === 0 ? [] : [{ sourceStart: 0, sourceLength: source.length, virtualStart: built.bodyOffset, virtualLength: source.length }],
    };
    this.templates.push({
      path: this.relative(realFile), source, dataType, options,
      views: resolution.views,
      defaultExtension: resolution.defaultExtension,
      names: specification.names ?? [], relationships: specification.relationships ?? [],
      dataDefinitions: specification.dataDefinitions ?? [], diagnostics: specification.diagnostics ?? [],
      symbols: specification.symbols ?? [], virtualDocument,
    });
    return this;
  }

  build(): Record<string, unknown> {
    const templates = sortByPath(this.templates).map((template) => ({
      path: template.path,
      sha256: sha256Text(template.source),
      options: template.options,
      dataType: template.dataType,
      dataDefinitions: template.dataDefinitions.map((definition) => ({ dataPath: [...definition.dataPath], location: this.location(definition.location) })),
      resolution: { views: template.views ?? null, defaultExtension: template.defaultExtension },
      relationships: [...template.relationships].map((value) => this.relative(path.resolve(this.root, value))).sort(compareText),
      diagnostics: [...template.diagnostics],
      virtualDocument: { content: template.virtualDocument.content, mappings: [...template.virtualDocument.mappings] },
    }));
    const templateNames = this.templates.flatMap((template) => template.names.map((name) => ({
      name: typeof name === "string" ? name : name.name,
      template: template.path,
      ...(typeof name === "string" || !name.definition ? {} : { definition: this.location(name.definition) }),
    })))
      .sort((left, right) => compareText(left.name, right.name));
    const symbols = this.templates.flatMap((template) => template.symbols).map((symbol) => ({
      id: symbol.id,
      occurrences: symbol.occurrences.map((occurrence) => ({ ...this.location(occurrence), role: occurrence.role })),
    })).sort((left, right) => compareText(left.id, right.id));
    const inputs = [...this.inputFiles.entries()].map(([fileName, sha256]) => ({ path: this.relative(fileName), sha256 }))
      .sort((left, right) => compareText(left.path, right.path));
    return { version: 1, inputs, templates, templateNames, symbols };
  }

  write(): string {
    this.assertInputsUnchanged();
    const manifest = this.build();
    validateEtaLanguageSupportManifest(this.root, manifest, this.output);
    const source = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES) {
      throw new Error(`Manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    this.assertSafeOutputTarget(this.output);
    fs.mkdirSync(path.dirname(this.output), { recursive: true });
    const temporary = `${this.output}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, source, "utf8");
      fs.renameSync(temporary, this.output);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
    return this.output;
  }

  private relative(fileName: string): string {
    const absolute = path.resolve(fileName);
    if (!isWithin(this.root, absolute)) throw new Error(`Path is outside the workspace root: ${fileName}`);
    return path.relative(this.root, absolute).split(path.sep).join("/");
  }

  private readTemplateSource(absolute: string, specification: EtaManifestTemplateOptions): string {
    if (specification.source === undefined) return fs.readFileSync(absolute, "utf8");
    const generatedRoot = path.join(this.root, ".eta-generated");
    if (!/\.eta$/i.test(absolute) || !isWithin(generatedRoot, absolute)) {
      throw new Error("Generated templates must use a .eta path under .eta-generated");
    }
    this.assertSafeGeneratedTarget(absolute);
    if (fs.existsSync(absolute) && fs.readFileSync(absolute, "utf8") !== specification.source && !specification.overwriteGenerated) {
      throw new Error("Refusing to replace an existing generated template without overwriteGenerated: true");
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, specification.source, "utf8");
    return specification.source;
  }

  private location(location: ManifestLocation): ManifestLocation {
    return { path: this.relative(path.resolve(this.root, location.path)), start: location.start, length: location.length };
  }

  private registerMetadataInputs(specification: EtaManifestTemplateOptions): void {
    for (const definition of specification.dataDefinitions ?? []) this.addInput(definition.location.path);
    for (const name of specification.names ?? []) {
      if (typeof name !== "string" && name.definition) this.addInput(name.definition.path);
    }
    for (const symbol of specification.symbols ?? []) {
      for (const occurrence of symbol.occurrences) this.addInput(occurrence.path);
    }
  }

  private assertInputsUnchanged(): void {
    for (const [fileName, expected] of this.inputFiles) {
      this.assertNotOutputFile(fileName, "an input");
      if (!fs.existsSync(fileName) || fileHash(fileName) !== expected) {
        throw new Error(`Manifest input changed after it was registered: ${fileName}`);
      }
    }
  }

  private assertNotOutputFile(fileName: string, role: string): void {
    const output = fs.existsSync(this.output) ? fs.realpathSync.native(this.output) : this.output;
    const candidate = fs.existsSync(fileName) ? fs.realpathSync.native(fileName) : fileName;
    if (canonical(fileName) === canonical(this.output) || canonical(candidate) === canonical(output)) {
      throw new Error(`Manifest output cannot also be ${role}`);
    }
  }

  private assertSafeGeneratedTarget(target: string): void {
    let ancestor = path.dirname(target);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const realAncestor = fs.realpathSync.native(ancestor);
    if (!isWithin(this.root, realAncestor)) throw new Error("Generated template path resolves outside the workspace root");
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        throw new Error("Generated template path must not be a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (fs.existsSync(target) && !isWithin(this.root, fs.realpathSync.native(target))) {
      throw new Error("Generated template path resolves outside the workspace root");
    }
  }

  private assertSafeOutputTarget(target: string): void {
    let ancestor = path.dirname(target);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (!isWithin(this.root, fs.realpathSync.native(ancestor))) {
      throw new Error("Manifest output path resolves outside the workspace root");
    }
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        throw new Error("Manifest output path must not be a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export interface EtaManifestConfigContext {
  builder: EtaManifestBuilder;
  EtaManifestBuilder: typeof EtaManifestBuilder;
}

let hasExecutedManifestConfig = false;

type ConfigModuleKind = "import" | "require";

interface ConfigModuleSpecifier {
  specifier: string;
  kind: ConfigModuleKind;
}

const CONFIG_RESOLVER = [
  'import { createRequire } from "node:module";',
  'import fs from "node:fs";',
  'const request = JSON.parse(fs.readFileSync(0, "utf8"));',
  'const target = request.kind === "import"',
  '  ? import.meta.resolve(request.specifier, request.parentUrl)',
  '  : createRequire(request.parentUrl).resolve(request.specifier);',
  'process.stdout.write(JSON.stringify(target));',
].join("\n");

function currentNodeConditions(): string[] {
  const conditions: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index];
    if ((argument === "--conditions" || argument === "-C") && process.execArgv[index + 1]) {
      conditions.push(argument, process.execArgv[index + 1]);
      index++;
    } else if (argument.startsWith("--conditions=") || argument.startsWith("-C=")) {
      conditions.push(argument);
    }
  }
  return conditions;
}

function resolveConfigModule(from: string, { specifier, kind }: ConfigModuleSpecifier): string | undefined {
  if (isBuiltin(specifier) || specifier.startsWith("node:")) return undefined;
  const request = JSON.stringify({ specifier, kind, parentUrl: pathToFileURL(from).href });
  const resolved = JSON.parse(execFileSync(
    process.execPath,
    [...currentNodeConditions(), "--experimental-import-meta-resolve", "--input-type=module", "--eval", CONFIG_RESOLVER],
    { encoding: "utf8", input: request, windowsHide: true },
  )) as string;
  if (kind === "require") return resolved;
  const url = new URL(resolved);
  // A data module's entire immutable source lives in its importing file; that
  // file is already hashed, and there is no separate filesystem dependency.
  return url.protocol === "data:" ? undefined : fileURLToPath(url);
}

function importIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  return Boolean(bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly));
}

function collectConfigModuleSpecifiers(source: ts.SourceFile): ConfigModuleSpecifier[] {
  const specifiers: ConfigModuleSpecifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !importIsTypeOnly(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({ specifier: node.moduleSpecifier.text, kind: "import" });
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({ specifier: node.moduleSpecifier.text, kind: "import" });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push({ specifier: node.arguments[0].text, kind: "require" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function trackConfigModuleMetadata(builder: EtaManifestBuilder, from: string): void {
  for (let directory = path.dirname(from); isWithin(builder.root, directory); directory = path.dirname(directory)) {
    for (const name of ["package.json", "package-lock.json", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) builder.addInput(candidate);
    }
    if (directory === builder.root) return;
  }
}

function trackManifestConfigInputs(builder: EtaManifestBuilder, fileName: string, seen = new Set<string>()): void {
  const real = containedExistingFile(builder.root, fileName, "Manifest config");
  if (seen.has(canonical(real))) return;
  seen.add(canonical(real));
  builder.addInput(real);
  trackConfigModuleMetadata(builder, real);
  const source = ts.createSourceFile(real, fs.readFileSync(real, "utf8"), ts.ScriptTarget.Latest, false);
  for (const specifier of collectConfigModuleSpecifiers(source)) {
    const resolved = resolveConfigModule(real, specifier);
    if (!resolved) continue;
    trackManifestConfigInputs(builder, resolved, seen);
  }
}

export async function runManifestConfig(fileName: string, root = path.dirname(fileName)): Promise<string> {
  if (hasExecutedManifestConfig) {
    throw new Error("Manifest config was already executed in this process; run a fresh `node out/manifest.js generate` process");
  }
  const builder = new EtaManifestBuilder({ root });
  const realConfig = fs.realpathSync.native(path.resolve(fileName));
  trackManifestConfigInputs(builder, realConfig);
  hasExecutedManifestConfig = true;
  const module = await import(pathToFileURL(realConfig).href);
  const configure = module.default;
  if (typeof configure !== "function") throw new Error("Manifest config must export a default function");
  await configure({ builder, EtaManifestBuilder });
  return builder.write();
}
