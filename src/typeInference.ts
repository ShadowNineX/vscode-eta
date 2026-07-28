import * as ts from "typescript";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyNonDefaultEtaLanguageOptions,
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
  normalizeEtaLanguageOptions,
} from "./etaConfig";
import { buildVirtualDocument, DEFAULT_IT_TYPE } from "./virtualDocument";
import {
  canonicalTemplatePath,
  resolveTemplatePath,
} from "./templatePaths";

/** Absolute fs paths of every .ts/.js file found in the workspace. */
export const workspaceTsFiles = new Set<string>();
/** Absolute fs paths of every .eta file found in the workspace. */
export const workspaceEtaFiles = new Set<string>();
export interface WorkspaceProject {
  root: string;
  rootNames: string[];
  options: ts.CompilerOptions;
}

export const workspaceProjects: WorkspaceProject[] = [];
/** Maps a canonical template path (or unresolved test key) to inferred data. */
export const templateDataTypeMap = new Map<string, string>();
/** Maps the same template identity to its statically inferred Eta config. */
export const templateLanguageOptionsMap = new Map<string, EtaLanguageOptions>();
export interface EtaTemplateResolutionOptions {
  views?: string;
  defaultExtension: string;
}

export const templateResolutionOptionsMap = new Map<
  string,
  EtaTemplateResolutionOptions
>();

export interface EtaDataDefinition {
  fileName: string;
  start: number;
  length: number;
}

/** Maps template basename -> data path -> source declarations. */
export const templateDataDefinitionMap = new Map<
  string,
  Map<string, EtaDataDefinition[]>
>();
interface EtaInstanceConfig {
  languageOptions: EtaLanguageOptions;
  views?: string;
  defaultExtension: string;
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
};

function readWorkspaceProject(root: string): WorkspaceProject | undefined {
  const configFile = ts.findConfigFile(
    root,
    ts.sys.fileExists,
    "tsconfig.json",
  ) ??
    ts.findConfigFile(root, ts.sys.fileExists, "jsconfig.json");
  if (!configFile) return undefined;

  const loaded = ts.readConfigFile(configFile, ts.sys.readFile);
  if (loaded.error) return undefined;
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    path.dirname(configFile),
    { noEmit: true },
    configFile,
  );
  return {
    root: path.dirname(configFile),
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  };
}

/** Scan one workspace root and load its TypeScript project configuration. */
export function scanWorkspaceFiles(root: string): void {
  try {
    const sourceFiles = ts.sys.readDirectory(
      root,
      [".ts", ".tsx", ".js", ".jsx"],
      ["node_modules", ".git", "out", "dist", "build"],
    );
    for (const fileName of sourceFiles) {
      if (!fileName.includes("node_modules")) workspaceTsFiles.add(fileName);
    }
    const etaFiles = ts.sys.readDirectory(
      root,
      [".eta"],
      ["node_modules", ".git", "out", "dist", "build"],
    );
    for (const fileName of etaFiles) {
      if (!fileName.includes("node_modules")) workspaceEtaFiles.add(fileName);
    }

    const configured = readWorkspaceProject(root);
    workspaceProjects.push(
      configured ?? {
        root,
        rootNames: sourceFiles,
        options: DEFAULT_COMPILER_OPTIONS,
      },
    );
  } catch {
    // Proceed without workspace context when the root is unreadable.
  }
}

// Methods whose first string argument names a file/cache template that can map
// back to a `.eta` document. `renderString*` is intentionally excluded: Eta
// uses those methods for inline template source, not template filenames.
// `renderFile*` is retained for legacy Eta v2 projects.
const ETA_NAMED_TEMPLATE_RENDER_METHODS = new Set([
  "render",
  "renderFile",
  "renderAsync",
  "renderFileAsync",
]);

/** Maximum recursion depth when expanding object types to avoid infinite loops. */
const MAX_TYPE_DEPTH = 6;

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

/** Expands an object/interface type into `{ prop: type; ... }` notation. */
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

/**
 * Recursively convert a TypeScript `Type` to a self-contained structural type
 * string that is safe to embed in `declare const it: <here>`.
 */
export function typeToStructuralString(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth = 0,
): string {
  if (depth > MAX_TYPE_DEPTH) return "unknown";

  if (type.isUnion()) {
    const unique = [
      ...new Set(
        type.types.map((t) => typeToStructuralString(checker, t, depth + 1)),
      ),
    ];
    return unique.join(" | ");
  }

  if (type.isIntersection()) {
    return type.types
      .map((t) => typeToStructuralString(checker, t, depth + 1))
      .join(" & ");
  }

  const primitive = primitiveFromFlags(type.flags);
  if (primitive !== undefined) return primitive;

  const literal = literalTypeToString(type);
  if (literal !== undefined) return literal;

  if (checker.isArrayType(type)) {
    const el = checker.getTypeArguments(type as ts.TypeReference)[0];
    return el
      ? `Array<${typeToStructuralString(checker, el, depth + 1)}>`
      : "Array<any>";
  }

  if (checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    return `[${args.map((t) => typeToStructuralString(checker, t, depth + 1)).join(", ")}]`;
  }

  if (type.getConstructSignatures().length > 0) {
    return type.getSymbol()?.name ?? checker.typeToString(type);
  }

  if (type.getCallSignatures().length > 0) {
    return checker
      .typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return expandObjectType(checker, type, depth);
}

function getCalledMethodName(expr: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return undefined;
}

function getCallReceiverName(expr: ts.Expression): string | undefined {
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression)
  ) {
    return expr.expression.text;
  }
  return undefined;
}

function getPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function getObjectProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = getPropertyName(property.name);
    if (name === propertyName) return property.initializer;
  }
  return undefined;
}

function getStringLiteralValue(expr: ts.Expression): string | undefined {
  return ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)
    ? expr.text
    : undefined;
}

function getStaticPathValue(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): string | undefined {
  const literal = getStringLiteralValue(expr);
  if (literal !== undefined) {
    return path.isAbsolute(literal)
      ? path.normalize(literal)
      : path.resolve(path.dirname(sourceFile.fileName), literal);
  }
  if (ts.isIdentifier(expr) && expr.text === "__dirname") {
    return path.dirname(sourceFile.fileName);
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "dirname" &&
    ts.isMetaProperty(expr.expression)
  ) {
    return path.dirname(sourceFile.fileName);
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    (expr.expression.name.text === "join" ||
      expr.expression.name.text === "resolve")
  ) {
    const parts = expr.arguments.map((argument) =>
      getStaticPathValue(argument, sourceFile),
    );
    if (parts.includes(undefined)) return undefined;
    return path.resolve(...(parts as string[]));
  }
  return undefined;
}

function getBooleanLiteralValue(expr: ts.Expression): boolean | undefined {
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function getStringArrayLiteralValue(expr: ts.Expression): string[] | undefined {
  if (!ts.isArrayLiteralExpression(expr)) return undefined;
  const values: string[] = [];
  for (const element of expr.elements) {
    if (!ts.isStringLiteral(element)) return undefined;
    values.push(element.text);
  }
  return values;
}

function getCustomTagPrefixes(expr: ts.Expression): string[] | undefined {
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) return [];
      const name = getPropertyName(property.name);
      return name === undefined ? [] : [name];
    });
  }
  return getStringArrayLiteralValue(expr);
}

function getTagsConfig(
  object: ts.ObjectLiteralExpression,
): [string, string] | undefined {
  const tags = getObjectProperty(object, "tags");
  const values = tags ? getStringArrayLiteralValue(tags) : undefined;
  return values && values.length >= 2 ? [values[0], values[1]] : undefined;
}

function getParseConfig(
  object: ts.ObjectLiteralExpression,
): EtaLanguageOptions["parse"] | undefined {
  const parse = getObjectProperty(object, "parse");
  if (!parse || !ts.isObjectLiteralExpression(parse)) return undefined;

  const config: Partial<EtaLanguageOptions["parse"]> = {};
  const exec = getObjectProperty(parse, "exec");
  const interpolate = getObjectProperty(parse, "interpolate");
  const raw = getObjectProperty(parse, "raw");

  if (exec) config.exec = getStringLiteralValue(exec) ?? "";
  if (interpolate) config.interpolate = getStringLiteralValue(interpolate) ?? "=";
  if (raw) config.raw = getStringLiteralValue(raw) ?? "~";

  return config as EtaLanguageOptions["parse"];
}

function getStringProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): string | undefined {
  const value = getObjectProperty(object, propertyName);
  return value ? getStringLiteralValue(value) : undefined;
}

function getBooleanProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): boolean | undefined {
  const value = getObjectProperty(object, propertyName);
  return value ? getBooleanLiteralValue(value) : undefined;
}

function getEtaConfigFromObjectLiteral(
  object: ts.ObjectLiteralExpression,
): Partial<EtaLanguageOptions> {
  const config: Partial<EtaLanguageOptions> = {};

  const tags = getTagsConfig(object);
  if (tags) config.tags = tags;

  const parse = getParseConfig(object);
  if (parse) config.parse = parse;

  const customTags = getObjectProperty(object, "customTags");
  const customTagPrefixes = customTags
    ? getCustomTagPrefixes(customTags)
    : undefined;
  if (customTagPrefixes) config.customTags = customTagPrefixes;

  config.varName = getStringProperty(object, "varName");

  config.useWith = getBooleanProperty(object, "useWith");

  config.functionHeader = getStringProperty(object, "functionHeader");

  config.outputFunctionName = getStringProperty(object, "outputFunctionName");

  return config;
}

function getEtaInstanceConfigFromExpression(
  expr: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): EtaInstanceConfig {
  const object = expr && ts.isObjectLiteralExpression(expr) ? expr : undefined;
  const viewsExpression = object
    ? getObjectProperty(object, "views")
    : undefined;
  return {
    languageOptions: object
      ? normalizeEtaLanguageOptions(getEtaConfigFromObjectLiteral(object))
      : DEFAULT_ETA_LANGUAGE_OPTIONS,
    views: viewsExpression
      ? getStaticPathValue(viewsExpression, sourceFile)
      : undefined,
    defaultExtension:
      (object && getStringProperty(object, "defaultExtension")) || ".eta",
  };
}

function symbolComesFromEta(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return false;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return (symbol.declarations ?? []).some((declaration) => {
    let current: ts.Node | undefined = declaration;
    while (current && !ts.isImportDeclaration(current)) current = current.parent;
    if (
      current &&
      ts.isStringLiteral(current.moduleSpecifier) &&
      current.moduleSpecifier.text === "eta"
    ) {
      return true;
    }
    return declaration
      .getSourceFile()
      .fileName.replaceAll("\\", "/")
      .includes("/node_modules/eta/");
  });
}

function isNewEtaExpression(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): expr is ts.NewExpression {
  if (!ts.isNewExpression(expr)) return false;
  if (symbolComesFromEta(expr.expression, checker)) return true;
  return (
    (ts.isIdentifier(expr.expression) && expr.expression.text === "Eta") ||
    (ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "Eta")
  );
}

function mergeInstanceConfig(
  base: EtaInstanceConfig,
  override: EtaInstanceConfig,
): EtaInstanceConfig {
  return {
    languageOptions: applyNonDefaultEtaLanguageOptions(
      base.languageOptions,
      override.languageOptions,
    ),
    views: override.views ?? base.views,
    defaultExtension:
      override.defaultExtension !== ".eta"
        ? override.defaultExtension
        : base.defaultExtension,
  };
}

function collectEtaInstanceConfigs(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Map<string, EtaInstanceConfig> {
  const configs = new Map<string, EtaInstanceConfig>();

  function configForExpression(
    expression: ts.Expression,
  ): EtaInstanceConfig | undefined {
    if (ts.isIdentifier(expression)) return configs.get(expression.text);
    if (isNewEtaExpression(expression, checker)) {
      return getEtaInstanceConfigFromExpression(
        expression.arguments?.[0],
        sourceFile,
      );
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "withConfig"
    ) {
      const base =
        configForExpression(expression.expression.expression) ?? {
          languageOptions: DEFAULT_ETA_LANGUAGE_OPTIONS,
          defaultExtension: ".eta",
        };
      return mergeInstanceConfig(
        base,
        getEtaInstanceConfigFromExpression(expression.arguments[0], sourceFile),
      );
    }
    return undefined;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const config = configForExpression(node.initializer);
      if (config) configs.set(node.name.text, config);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "configure" &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const instanceName = node.expression.expression.text;
      const base = configs.get(instanceName);
      if (base) {
        configs.set(
          instanceName,
          mergeInstanceConfig(
            base,
            getEtaInstanceConfigFromExpression(node.arguments[0], sourceFile),
          ),
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return configs;
}

function templateKeysForWrite(key: string): string[] {
  if (!path.isAbsolute(key)) return [key];
  const basename = path.basename(key, path.extname(key));
  const matchingTemplates = [...workspaceEtaFiles].filter(
    (fileName) =>
      path.basename(fileName, path.extname(fileName)).toLowerCase() ===
      basename.toLowerCase(),
  );
  return matchingTemplates.length === 1 ? [key, basename] : [key];
}

function setTemplateLanguageOptions(
  key: string,
  options: EtaLanguageOptions,
): void {
  for (const writeKey of templateKeysForWrite(key)) {
    templateLanguageOptionsMap.set(writeKey, options);
  }
}

function setTemplateResolutionOptions(
  key: string,
  options: EtaTemplateResolutionOptions,
): void {
  for (const writeKey of templateKeysForWrite(key)) {
    templateResolutionOptionsMap.set(writeKey, options);
  }
}

function mergeTemplateType(key: string, typeStr: string): void {
  for (const writeKey of templateKeysForWrite(key)) {
    const existing = templateDataTypeMap.get(writeKey);
    if (!existing) {
      templateDataTypeMap.set(writeKey, typeStr);
    } else if (existing !== typeStr && !existing.includes(typeStr)) {
      templateDataTypeMap.set(writeKey, `${existing} & ${typeStr}`);
    }
  }
}

function dataPathKey(dataPath: string[]): string {
  return JSON.stringify(dataPath);
}

function definitionNodeForSymbol(symbol: ts.Symbol): ts.Node | undefined {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return undefined;

  const name = (declaration as ts.NamedDeclaration).name;
  return name && !ts.isComputedPropertyName(name) ? name : declaration;
}

function addTemplateDataDefinition(
  templateKey: string,
  dataPath: string[],
  node: ts.Node,
): void {
  const sourceFile = node.getSourceFile();
  const definition: EtaDataDefinition = {
    fileName: sourceFile.fileName,
    start: node.getStart(sourceFile),
    length: node.getWidth(sourceFile),
  };
  for (const writeKey of templateKeysForWrite(templateKey)) {
    let definitionsByPath = templateDataDefinitionMap.get(writeKey);
    if (!definitionsByPath) {
      definitionsByPath = new Map();
      templateDataDefinitionMap.set(writeKey, definitionsByPath);
    }

    const key = dataPathKey(dataPath);
    const definitions = definitionsByPath.get(key) ?? [];
    if (
      !definitions.some(
        (existing) =>
          existing.fileName === definition.fileName &&
          existing.start === definition.start &&
          existing.length === definition.length,
      )
    ) {
      definitions.push(definition);
      definitionsByPath.set(key, definitions);
    }
  }
}

function collectTypeDataDefinitions(
  templateKey: string,
  checker: ts.TypeChecker,
  type: ts.Type,
  dataPath: string[],
  fallbackNode: ts.Node,
  depth = 0,
): void {
  if (depth > MAX_TYPE_DEPTH) return;

  if (type.isUnionOrIntersection()) {
    for (const member of type.types) {
      collectTypeDataDefinitions(
        templateKey,
        checker,
        member,
        dataPath,
        fallbackNode,
        depth + 1,
      );
    }
    return;
  }

  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    for (const elementType of checker.getTypeArguments(
      type as ts.TypeReference,
    )) {
      collectTypeDataDefinitions(
        templateKey,
        checker,
        elementType,
        dataPath,
        fallbackNode,
        depth + 1,
      );
    }
    return;
  }

  if (
    primitiveFromFlags(type.flags) !== undefined ||
    literalTypeToString(type) !== undefined ||
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0
  ) {
    return;
  }

  for (const property of checker.getPropertiesOfType(type)) {
    const propertyPath = [...dataPath, property.name];
    const definitionNode = definitionNodeForSymbol(property);
    if (definitionNode) {
      addTemplateDataDefinition(templateKey, propertyPath, definitionNode);
    }

    try {
      const propertyType = checker.getTypeOfSymbolAtLocation(
        property,
        definitionNode ?? fallbackNode,
      );
      collectTypeDataDefinitions(
        templateKey,
        checker,
        propertyType,
        propertyPath,
        definitionNode ?? fallbackNode,
        depth + 1,
      );
    } catch {
      // Some synthetic symbols do not expose a resolvable source type.
    }
  }
}

function expressionDefinitionNode(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Node {
  let symbolNode: ts.Node = expression;
  if (ts.isPropertyAccessExpression(expression)) {
    symbolNode = expression.name;
  } else if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression
  ) {
    symbolNode = expression.argumentExpression;
  }
  const symbol = checker.getSymbolAtLocation(symbolNode);
  return (symbol && definitionNodeForSymbol(symbol)) ?? expression;
}

function mergeTemplateDataDefinitions(
  targetKey: string,
  sourceKey: string,
): void {
  const source =
    templateDataDefinitionMap.get(sourceKey) ??
    templateDataDefinitionMap.get(
      path.basename(sourceKey, path.extname(sourceKey)),
    );
  if (!source) return;

  for (const writeKey of templateKeysForWrite(targetKey)) {
    let target = templateDataDefinitionMap.get(writeKey);
    if (!target) {
      target = new Map();
      templateDataDefinitionMap.set(writeKey, target);
    }

    for (const [key, definitions] of source) {
      const targetDefinitions = target.get(key) ?? [];
      for (const definition of definitions) {
        if (
          !targetDefinitions.some(
            (existing) =>
              existing.fileName === definition.fileName &&
              existing.start === definition.start &&
              existing.length === definition.length,
          )
        ) {
          targetDefinitions.push(definition);
        }
      }
      target.set(key, targetDefinitions);
    }
  }
}

function templateKeyForReference(
  templateName: string,
  sourceFile: ts.SourceFile,
  config?: EtaInstanceConfig,
): string {
  const resolved = resolveTemplatePath(templateName, {
    fromFile: sourceFile.fileName,
    views: config?.views,
    defaultExtension: config?.defaultExtension,
    templateFiles: workspaceEtaFiles,
  });
  if (resolved) return resolved;

  const basename = path.basename(templateName, path.extname(templateName));
  const basenameMatches = [...workspaceEtaFiles].filter(
    (fileName) =>
      path.basename(fileName, path.extname(fileName)).toLowerCase() ===
      basename.toLowerCase(),
  );
  return basenameMatches.length > 1
    ? `unresolved:${canonicalTemplatePath(sourceFile.fileName)}:${templateName}`
    : basename;
}

function recordRenderCallType(
  templateName: string,
  dataArg: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  config?: EtaInstanceConfig,
): void {
  const templateKey = templateKeyForReference(templateName, sourceFile, config);
  if (config) {
    setTemplateLanguageOptions(templateKey, config.languageOptions);
    setTemplateResolutionOptions(templateKey, {
      views: config.views,
      defaultExtension: config.defaultExtension,
    });
  }
  try {
    const type = checker.getTypeAtLocation(dataArg);
    const typeStr = typeToStructuralString(checker, type);
    if (typeStr === "any" || typeStr === "unknown") return;
    mergeTemplateType(templateKey, typeStr);
    addTemplateDataDefinition(
      templateKey,
      [],
      expressionDefinitionNode(dataArg, checker),
    );
    collectTypeDataDefinitions(templateKey, checker, type, [], dataArg);
  } catch {
    // Type extraction failed for this call; skip it.
  }
}

function withLayoutBody(typeStr: string): string {
  if (/\bbody\??:/.test(typeStr)) return typeStr;
  const trimmed = typeStr.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return `${trimmed.slice(0, -1).trimEnd()}; body: string }`;
  }
  return `{ body: string } & ${trimmed}`;
}

function templateKeyFromPath(filePath: string): string {
  return canonicalTemplatePath(filePath);
}

function expressionToStructuralString(
  expression: ts.Expression,
): string | undefined {
  if (ts.isStringLiteralLike(expression)) return "string";
  if (ts.isNumericLiteral(expression)) return "number";
  if (
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return "boolean";
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const elementTypes = [
      ...new Set(
        expression.elements
          .map((element) =>
            ts.isExpression(element)
              ? expressionToStructuralString(element)
              : undefined,
          )
          .filter((value): value is string => value !== undefined),
      ),
    ];
    return `Array<${elementTypes.join(" | ") || "unknown"}>`;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const properties = expression.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) return [];
      const name = getPropertyName(property.name);
      const type = expressionToStructuralString(property.initializer);
      return name && type ? [`${name}: ${type}`] : [];
    });
    return `{ ${properties.join("; ")} }`;
  }
  return undefined;
}

const TEMPLATE_RELATIONSHIP_HELPERS = new Set([
  "include",
  "includeAsync",
  "layout",
]);

type TemplateRelationshipCall = ts.CallExpression & {
  expression: ts.Identifier;
};

interface TemplateRelationshipContext {
  etaFile: string;
  sourceKey: string;
  sourceType: string;
  options: EtaLanguageOptions;
  resolution: EtaTemplateResolutionOptions | undefined;
}

function isTemplateRelationshipCall(
  node: ts.Node,
): node is TemplateRelationshipCall {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    TEMPLATE_RELATIONSHIP_HELPERS.has(node.expression.text)
  );
}

function getRelationshipTargetKey(
  call: TemplateRelationshipCall,
  context: TemplateRelationshipContext,
): string | undefined {
  const templateArgument = call.arguments[0];
  if (!templateArgument) return undefined;
  const templateName = getStringLiteralValue(templateArgument);
  if (templateName === undefined) return undefined;
  return (
    resolveTemplatePath(templateName, {
      fromFile: context.etaFile,
      views: context.resolution?.views,
      defaultExtension: context.resolution?.defaultExtension,
      templateFiles: workspaceEtaFiles,
    }) ?? path.basename(templateName, path.extname(templateName))
  );
}

function getPropagatedRelationshipType(
  call: TemplateRelationshipCall,
  sourceType: string,
): string {
  let propagatedType = sourceType;
  const dataArgument = call.arguments[1];
  if (dataArgument) {
    const explicitType = expressionToStructuralString(dataArgument);
    if (explicitType) propagatedType = `${sourceType} & ${explicitType}`;
  }
  return call.expression.text === "layout"
    ? withLayoutBody(propagatedType)
    : propagatedType;
}

function recordTemplateRelationship(
  call: TemplateRelationshipCall,
  context: TemplateRelationshipContext,
): void {
  const targetKey = getRelationshipTargetKey(call, context);
  if (!targetKey || targetKey === context.sourceKey) return;

  mergeTemplateType(
    targetKey,
    getPropagatedRelationshipType(call, context.sourceType),
  );
  mergeTemplateDataDefinitions(targetKey, context.sourceKey);
  if (!templateLanguageOptionsMap.has(targetKey)) {
    setTemplateLanguageOptions(targetKey, context.options);
  }
  if (
    context.resolution &&
    !templateResolutionOptionsMap.has(targetKey)
  ) {
    setTemplateResolutionOptions(targetKey, context.resolution);
  }
}

function analyzeTemplateRelationships(
  etaFile: string,
  source: string,
  sourceType: string,
  options: EtaLanguageOptions,
): void {
  const virtualFileName = `${etaFile}.ts`;
  const virtual = buildVirtualDocument(source, sourceType, options);
  const sourceFile = ts.createSourceFile(
    virtualFileName,
    virtual.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sourceKey = templateKeyFromPath(etaFile);
  const context: TemplateRelationshipContext = {
    etaFile,
    sourceKey,
    sourceType,
    options,
    resolution:
      templateResolutionOptionsMap.get(sourceKey) ??
      templateResolutionOptionsMap.get(
        path.basename(etaFile, path.extname(etaFile)),
      ),
  };

  function visit(node: ts.Node): void {
    if (isTemplateRelationshipCall(node)) {
      recordTemplateRelationship(node, context);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

export function analyzeEtaTemplateLayouts(etaFiles: string[]): void {
  for (const etaFile of etaFiles) workspaceEtaFiles.add(etaFile);
  for (let pass = 0; pass < MAX_TYPE_DEPTH; pass++) {
    const before = new Map(templateDataTypeMap);
    for (const etaFile of etaFiles) {
      const templateKey = templateKeyFromPath(etaFile);
      const sourceType =
        templateDataTypeMap.get(templateKey) ??
        templateDataTypeMap.get(path.basename(etaFile, path.extname(etaFile)));
      if (!sourceType) continue;
      const source = ts.sys.readFile(etaFile);
      if (source === undefined) continue;
      const basename = path.basename(etaFile, path.extname(etaFile));
      const options =
        templateLanguageOptionsMap.get(templateKey) ??
        templateLanguageOptionsMap.get(basename) ??
        DEFAULT_ETA_LANGUAGE_OPTIONS;
      analyzeTemplateRelationships(etaFile, source, sourceType, options);
    }
    if (
      before.size === templateDataTypeMap.size &&
      [...before].every(([key, value]) => templateDataTypeMap.get(key) === value)
    ) {
      break;
    }
  }
}

/**
 * Walk one source file's AST looking for `eta.render*(templateLiteral, data)`
 * calls and record the inferred structural type of `data`.
 */
export function analyzeFileForEtaCalls(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): void {
  const etaInstanceConfigs = collectEtaInstanceConfigs(sourceFile, checker);

  function configForRenderCall(
    call: ts.CallExpression,
  ): EtaInstanceConfig | undefined {
    if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
    const receiver = call.expression.expression;
    if (ts.isIdentifier(receiver)) return etaInstanceConfigs.get(receiver.text);
    if (
      ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      receiver.expression.name.text === "withConfig"
    ) {
      const baseReceiver = receiver.expression.expression;
      const base =
        (ts.isIdentifier(baseReceiver)
          ? etaInstanceConfigs.get(baseReceiver.text)
          : undefined) ?? {
          languageOptions: DEFAULT_ETA_LANGUAGE_OPTIONS,
          defaultExtension: ".eta",
        };
      return mergeInstanceConfig(
        base,
        getEtaInstanceConfigFromExpression(receiver.arguments[0], sourceFile),
      );
    }
    return undefined;
  }

  function isEtaRenderCall(
    call: ts.CallExpression,
    methodName: string,
  ): boolean {
    if (ts.isIdentifier(call.expression)) {
      return (
        symbolComesFromEta(call.expression, checker) ||
        ETA_NAMED_TEMPLATE_RENDER_METHODS.has(call.expression.text)
      );
    }
    if (!ts.isPropertyAccessExpression(call.expression)) return false;
    const receiver = call.expression.expression;
    if (ts.isIdentifier(receiver)) {
      return (
        etaInstanceConfigs.has(receiver.text) ||
        receiver.text.toLowerCase() === "eta" ||
        symbolComesFromEta(receiver, checker) ||
        symbolComesFromEta(call.expression.name, checker)
      );
    }
    const config = configForRenderCall(call);
    return (
      config !== undefined ||
      (methodName.startsWith("render") &&
        symbolComesFromEta(call.expression.name, checker))
    );
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const methodName = getCalledMethodName(node.expression);
      if (
        methodName &&
        ETA_NAMED_TEMPLATE_RENDER_METHODS.has(methodName) &&
        isEtaRenderCall(node, methodName)
      ) {
        const templateName = node.arguments[0]
          ? getStringLiteralValue(node.arguments[0])
          : undefined;
        const dataArgument = node.arguments[1];
        if (templateName !== undefined && dataArgument) {
          recordRenderCallType(
            templateName,
            dataArgument,
            checker,
            sourceFile,
            configForRenderCall(node),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

export interface WorkspaceAnalysisHooks {
  onError?: (fileName: string, error: unknown) => void;
  onMapping?: (fileName: string, key: string, value: string) => void;
  onFailure?: (error: unknown) => void;
}

function analyzeOneSourceFile(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  hooks: WorkspaceAnalysisHooks,
): void {
  const before = new Map(templateDataTypeMap);
  try {
    analyzeFileForEtaCalls(sf, checker);
  } catch (e) {
    hooks.onError?.(sf.fileName, e);
  }
  for (const [k, v] of templateDataTypeMap) {
    if (!before.has(k) || before.get(k) !== v) {
      hooks.onMapping?.(sf.fileName, k, v);
    }
  }
}

export function analyzeWorkspaceFiles(
  rootNames: string[],
  hooks: WorkspaceAnalysisHooks = {},
  projects: WorkspaceProject[] = [],
): void {
  try {
    const configuredProjects =
      projects.length > 0
        ? projects
        : [
            {
              root: process.cwd(),
              rootNames,
              options: DEFAULT_COMPILER_OPTIONS,
            },
          ];
    const analyzedFiles = new Set<string>();
    for (const project of configuredProjects) {
      const program = ts.createProgram({
        rootNames: project.rootNames,
        options: project.options,
      });
      const checker = program.getTypeChecker();
      const rootSet = new Set(project.rootNames.map((file) => path.normalize(file)));
      for (const sourceFile of program.getSourceFiles()) {
        const fileName = path.normalize(sourceFile.fileName);
        if (
          sourceFile.isDeclarationFile ||
          !rootSet.has(fileName) ||
          analyzedFiles.has(fileName)
        ) {
          continue;
        }
        analyzedFiles.add(fileName);
        analyzeOneSourceFile(sourceFile, checker, hooks);
      }
    }
    analyzeEtaTemplateLayouts([...workspaceEtaFiles]);
  } catch (error) {
    hooks.onFailure?.(error);
  }
}

export function getWorkspaceProjectForFile(
  fileName: string,
): WorkspaceProject | undefined {
  const normalized = canonicalTemplatePath(fileName);
  return workspaceProjects
    .filter((project) => {
      const relative = path.relative(
        canonicalTemplatePath(project.root),
        normalized,
      );
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })
    .sort((left, right) => right.root.length - left.root.length)[0];
}

function mapKeyForTemplateUri<T>(
  uri: string,
  values: Map<string, T>,
): string | undefined {
  const fsPath = fileURLToPath(uri);
  const exact = canonicalTemplatePath(fsPath);
  if (values.has(exact)) return exact;

  const basename = path.basename(fsPath, path.extname(fsPath));
  if (values.has(basename)) return basename;
  const matches = [...values.keys()].filter(
    (key) =>
      path.basename(key, path.extname(key)).toLowerCase() ===
      basename.toLowerCase(),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Return the data type inferred for this template URI, or the default. */
export function getItTypeForUri(uri: string): string {
  try {
    const key = mapKeyForTemplateUri(uri, templateDataTypeMap);
    return (key && templateDataTypeMap.get(key)) ?? DEFAULT_IT_TYPE;
  } catch {
    return DEFAULT_IT_TYPE;
  }
}

/** Return source declarations for an inferred data path in this template. */
export function getDataDefinitionsForUri(
  uri: string,
  dataPath: string[],
): EtaDataDefinition[] {
  try {
    const key = mapKeyForTemplateUri(uri, templateDataDefinitionMap);
    return (
      (key &&
        templateDataDefinitionMap.get(key)?.get(dataPathKey(dataPath))) ||
      []
    );
  } catch {
    return [];
  }
}

export function getEtaLanguageOptionsForUri(
  uri: string,
): EtaLanguageOptions | undefined {
  try {
    const key = mapKeyForTemplateUri(uri, templateLanguageOptionsMap);
    return key ? templateLanguageOptionsMap.get(key) : undefined;
  } catch {
    return undefined;
  }
}

export function getTemplateResolutionOptionsForUri(
  uri: string,
): EtaTemplateResolutionOptions | undefined {
  try {
    const key = mapKeyForTemplateUri(uri, templateResolutionOptionsMap);
    return key ? templateResolutionOptionsMap.get(key) : undefined;
  } catch {
    return undefined;
  }
}
