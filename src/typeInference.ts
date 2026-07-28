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
  findMostSpecificContainingRoot,
  resolveTemplatePath,
} from "./templatePaths";

export const WORKSPACE_SCRIPT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

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

export const templateRelationshipMap = new Map<string, Set<string>>();

export interface EtaDataDefinition {
  fileName: string;
  start: number;
  length: number;
}

interface EtaTemplateRegistration extends EtaDataDefinition {
  name: string;
}

export const templateRegistrationMap = new Map<
  string,
  EtaTemplateRegistration[]
>();

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
      [...WORKSPACE_SCRIPT_EXTENSIONS],
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

function typePropertyName(name: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(name) ? name : JSON.stringify(name);
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
      return `${typePropertyName(prop.name)}${optional}: ${propStr}`;
    } catch {
      return `${typePropertyName(prop.name)}${optional}: unknown`;
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

function resolveStaticExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return resolveStaticExpression(expression.expression, checker, seen);
  }

  const symbolNode = ts.isPropertyAccessExpression(expression)
    ? expression.name
    : expression;
  let symbol = checker.getSymbolAtLocation(symbolNode);
  if (!symbol || seen.has(symbol)) return expression;
  seen.add(symbol);
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  let initializer: ts.Expression | undefined;
  if (
    declaration &&
    (ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration) ||
      ts.isParameter(declaration))
  ) {
    initializer = declaration.initializer;
  } else if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
    const valueSymbol = checker.getShorthandAssignmentValueSymbol(declaration);
    const valueDeclaration =
      valueSymbol?.valueDeclaration ?? valueSymbol?.declarations?.[0];
    if (valueDeclaration && ts.isVariableDeclaration(valueDeclaration)) {
      initializer = valueDeclaration.initializer;
    }
  }
  return initializer
    ? resolveStaticExpression(initializer, checker, seen)
    : expression;
}

function getStaticPathValue(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
): string | undefined {
  const resolved = checker ? resolveStaticExpression(expr, checker) : expr;
  if (resolved !== expr) {
    return getStaticPathValue(
      resolved,
      resolved.getSourceFile(),
      checker,
    );
  }
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
      getStaticPathValue(argument, sourceFile, checker),
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

function getTrimModeLiteralValue(
  expression: ts.Expression,
): "nl" | "slurp" | false | undefined {
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  const value = getStringLiteralValue(expression);
  return value === "nl" || value === "slurp" ? value : undefined;
}

function getAutoTrimConfig(
  object: ts.ObjectLiteralExpression,
): EtaLanguageOptions["autoTrim"] {
  const value = getObjectProperty(object, "autoTrim");
  if (!value) return undefined;
  if (ts.isArrayLiteralExpression(value) && value.elements.length >= 2) {
    const before = getTrimModeLiteralValue(value.elements[0] as ts.Expression);
    const after = getTrimModeLiteralValue(value.elements[1] as ts.Expression);
    return before !== undefined && after !== undefined
      ? [before, after]
      : undefined;
  }
  return getTrimModeLiteralValue(value);
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

  config.async = getBooleanProperty(object, "async");
  config.autoEscape = getBooleanProperty(object, "autoEscape");
  config.autoFilter = getBooleanProperty(object, "autoFilter");
  config.autoTrim = getAutoTrimConfig(object);
  config.rmWhitespace = getBooleanProperty(object, "rmWhitespace");

  return config;
}

function getEtaInstanceConfigFromExpression(
  expr: ts.Expression | undefined,
  checker: ts.TypeChecker,
): EtaInstanceConfig {
  const resolved = expr ? resolveStaticExpression(expr, checker) : undefined;
  const object =
    resolved && ts.isObjectLiteralExpression(resolved) ? resolved : undefined;
  const viewsExpression = object
    ? getObjectProperty(object, "views")
    : undefined;
  return {
    languageOptions: object
      ? normalizeEtaLanguageOptions(getEtaConfigFromObjectLiteral(object))
      : DEFAULT_ETA_LANGUAGE_OPTIONS,
    views: viewsExpression
      ? getStaticPathValue(viewsExpression, viewsExpression.getSourceFile(), checker)
      : undefined,
    defaultExtension:
      (object && getStringProperty(object, "defaultExtension")) || ".eta",
  };
}

function declarationComesFromEta(declaration: ts.Declaration): boolean {
  const normalizedFileName = declaration
    .getSourceFile()
    .fileName.replaceAll("\\", "/");
  if (normalizedFileName.includes("/node_modules/eta/")) return true;

  let current: ts.Node | undefined = declaration;
  while (current) {
    if (
      (ts.isImportDeclaration(current) ||
        ts.isExportDeclaration(current)) &&
      current.moduleSpecifier &&
      ts.isStringLiteral(current.moduleSpecifier) &&
      current.moduleSpecifier.text === "eta"
    ) {
      return true;
    }
    if (
      ts.isImportEqualsDeclaration(current) &&
      ts.isExternalModuleReference(current.moduleReference) &&
      current.moduleReference.expression &&
      ts.isStringLiteral(current.moduleReference.expression) &&
      current.moduleReference.expression.text === "eta"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function symbolHasEtaDeclaration(symbol: ts.Symbol | undefined): boolean {
  return (
    symbol?.declarations?.some((declaration) =>
      declarationComesFromEta(declaration),
    ) ?? false
  );
}

function symbolComesFromEta(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return false;
  if (symbolHasEtaDeclaration(symbol)) return true;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    return symbolHasEtaDeclaration(checker.getAliasedSymbol(symbol));
  }
  return false;
}

function typeComesFromEta(node: ts.Node, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(node);
  if (
    symbolHasEtaDeclaration(type.getSymbol()) ||
    symbolHasEtaDeclaration(type.aliasSymbol)
  ) {
    return true;
  }
  for (const signature of [
    ...type.getCallSignatures(),
    ...type.getConstructSignatures(),
  ]) {
    if (
      signature.declaration &&
      declarationComesFromEta(signature.declaration)
    ) {
      return true;
    }
  }
  for (const methodName of ETA_NAMED_TEMPLATE_RENDER_METHODS) {
    if (symbolHasEtaDeclaration(type.getProperty(methodName))) return true;
  }
  return false;
}

function isNewEtaExpression(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): expr is ts.NewExpression {
  return (
    ts.isNewExpression(expr) &&
    (symbolComesFromEta(expr.expression, checker) ||
      typeComesFromEta(expr.expression, checker))
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

type EtaInstanceConfigResolver = (
  expression: ts.Expression,
) => EtaInstanceConfig | undefined;

function collectEtaInstanceConfigs(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): EtaInstanceConfigResolver {
  const configs = new Map<ts.Symbol, EtaInstanceConfig>();
  const resolving = new Set<ts.Symbol>();

  function getExpressionSymbol(
    expression: ts.Expression,
  ): ts.Symbol | undefined {
    const symbolNode = ts.isPropertyAccessExpression(expression)
      ? expression.name
      : expression;
    let symbol = checker.getSymbolAtLocation(symbolNode);
    if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  }

  function configForExpression(
    expression: ts.Expression,
  ): EtaInstanceConfig | undefined {
    const symbol = getExpressionSymbol(expression);
    if (symbol) {
      const existing = configs.get(symbol);
      if (existing) return existing;
      if (resolving.has(symbol)) return undefined;
      resolving.add(symbol);
    }

    let config: EtaInstanceConfig | undefined;
    const resolved = resolveStaticExpression(expression, checker);
    if (resolved !== expression) {
      config = configForExpression(resolved);
    } else if (isNewEtaExpression(expression, checker)) {
      config = getEtaInstanceConfigFromExpression(
        expression.arguments?.[0],
        checker,
      );
    } else if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "withConfig" &&
      typeComesFromEta(expression.expression.expression, checker)
    ) {
      const base =
        configForExpression(expression.expression.expression) ?? {
          languageOptions: DEFAULT_ETA_LANGUAGE_OPTIONS,
          defaultExtension: ".eta",
        };
      config = mergeInstanceConfig(
        base,
        getEtaInstanceConfigFromExpression(expression.arguments[0], checker),
      );
    } else if (typeComesFromEta(expression, checker)) {
      config = {
        languageOptions: DEFAULT_ETA_LANGUAGE_OPTIONS,
        defaultExtension: ".eta",
      };
    }

    if (symbol) {
      resolving.delete(symbol);
      if (config) configs.set(symbol, config);
    }
    return config;
  }

  function setExpressionConfig(
    expression: ts.Expression,
    config: EtaInstanceConfig,
  ): void {
    const symbol = getExpressionSymbol(expression);
    if (symbol) configs.set(symbol, config);
  }

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const config = configForExpression(node.initializer);
      if (config) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) configs.set(symbol, config);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "configure"
    ) {
      const receiver = node.expression.expression;
      const base = configForExpression(receiver);
      if (base) {
        setExpressionConfig(
          receiver,
          mergeInstanceConfig(
            base,
            getEtaInstanceConfigFromExpression(node.arguments[0], checker),
          ),
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return configForExpression;
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

const templateDataTypeVariantsMap = new Map<string, Set<string>>();

function renderTypeVariants(variants: Set<string>): string {
  const values = [...variants];
  return values.length === 1
    ? values[0]
    : values.map((value) => `(${value})`).join(" | ");
}

function mergeTemplateType(key: string, typeStr: string): void {
  for (const writeKey of templateKeysForWrite(key)) {
    const existing = templateDataTypeMap.get(writeKey);
    let variants = templateDataTypeVariantsMap.get(writeKey);
    if (!existing) {
      variants = new Set([typeStr]);
    } else if (!variants || renderTypeVariants(variants) !== existing) {
      variants = new Set([existing]);
    }
    variants.add(typeStr);
    templateDataTypeVariantsMap.set(writeKey, variants);
    templateDataTypeMap.set(writeKey, renderTypeVariants(variants));
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

function storeTemplateDataDefinition(
  templateKey: string,
  dataPath: string[],
  definition: EtaDataDefinition,
): void {
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

function addTemplateDataDefinition(
  templateKey: string,
  dataPath: string[],
  node: ts.Node,
): void {
  const sourceFile = node.getSourceFile();
  storeTemplateDataDefinition(templateKey, dataPath, {
    fileName: sourceFile.fileName,
    start: node.getStart(sourceFile),
    length: node.getWidth(sourceFile),
  });
}

type DataDefinitionRecorder = (dataPath: string[], node: ts.Node) => void;

function collectTypeDataDefinitions(
  checker: ts.TypeChecker,
  type: ts.Type,
  dataPath: string[],
  fallbackNode: ts.Node,
  recordDefinition: DataDefinitionRecorder,
  depth = 0,
): void {
  if (depth > MAX_TYPE_DEPTH) return;

  if (type.isUnionOrIntersection()) {
    for (const member of type.types) {
      collectTypeDataDefinitions(
        checker,
        member,
        dataPath,
        fallbackNode,
        recordDefinition,
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
        checker,
        elementType,
        dataPath,
        fallbackNode,
        recordDefinition,
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
    if (definitionNode) recordDefinition(propertyPath, definitionNode);

    try {
      const propertyType = checker.getTypeOfSymbolAtLocation(
        property,
        definitionNode ?? fallbackNode,
      );
      collectTypeDataDefinitions(
        checker,
        propertyType,
        propertyPath,
        definitionNode ?? fallbackNode,
        recordDefinition,
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

function isDataPathOverridden(
  key: string,
  overriddenTopLevelNames: Set<string>,
): boolean {
  for (const name of overriddenTopLevelNames) {
    const topLevelKey = dataPathKey([name]);
    if (
      key === topLevelKey ||
      key.startsWith(`${topLevelKey.slice(0, -1)},`)
    ) {
      return true;
    }
  }
  return false;
}

function getOrCreateTemplateDataDefinitions(
  templateKey: string,
): Map<string, EtaDataDefinition[]> {
  let definitions = templateDataDefinitionMap.get(templateKey);
  if (!definitions) {
    definitions = new Map();
    templateDataDefinitionMap.set(templateKey, definitions);
  }
  return definitions;
}

function areDataDefinitionsEqual(
  left: EtaDataDefinition,
  right: EtaDataDefinition,
): boolean {
  return (
    left.fileName === right.fileName &&
    left.start === right.start &&
    left.length === right.length
  );
}

function mergeTemplateDataDefinitionEntry(
  target: Map<string, EtaDataDefinition[]>,
  key: string,
  definitions: EtaDataDefinition[],
): void {
  const targetDefinitions = target.get(key) ?? [];
  for (const definition of definitions) {
    if (
      !targetDefinitions.some((existing) =>
        areDataDefinitionsEqual(existing, definition),
      )
    ) {
      targetDefinitions.push(definition);
    }
  }
  target.set(key, targetDefinitions);
}

function mergeTemplateDataDefinitions(
  targetKey: string,
  sourceKey: string,
  overriddenTopLevelNames = new Set<string>(),
): void {
  const source =
    templateDataDefinitionMap.get(sourceKey) ??
    templateDataDefinitionMap.get(
      path.basename(sourceKey, path.extname(sourceKey)),
    );
  if (!source) return;

  for (const writeKey of templateKeysForWrite(targetKey)) {
    const target = getOrCreateTemplateDataDefinitions(writeKey);
    for (const [key, definitions] of source) {
      if (isDataPathOverridden(key, overriddenTopLevelNames)) continue;
      mergeTemplateDataDefinitionEntry(target, key, definitions);
    }
  }
}

function addTypePropertyNames(
  names: Set<string>,
  type: ts.Type,
  checker: ts.TypeChecker,
): void {
  for (const symbol of checker.getPropertiesOfType(type)) {
    names.add(symbol.name);
  }
}

function isSourceDataSpread(
  expression: ts.Expression,
  context: TemplateRelationshipContext,
): boolean {
  return (
    ts.isIdentifier(expression) &&
    expression.text === context.options.varName
  );
}

function addObjectLiteralOverrideNames(
  names: Set<string>,
  expression: ts.ObjectLiteralExpression,
  context: TemplateRelationshipContext,
): void {
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (!isSourceDataSpread(property.expression, context)) {
        const spreadType = context.checker.getTypeAtLocation(
          property.expression,
        );
        addTypePropertyNames(names, spreadType, context.checker);
      }
      continue;
    }
    const name = property.name && getPropertyName(property.name);
    if (name !== undefined) names.add(name);
  }
}

function getOverriddenTopLevelNames(
  expression: ts.Expression,
  context: TemplateRelationshipContext,
): Set<string> {
  const names = new Set<string>();
  if (ts.isObjectLiteralExpression(expression)) {
    addObjectLiteralOverrideNames(names, expression, context);
  } else {
    const type = context.checker.getTypeAtLocation(expression);
    addTypePropertyNames(names, type, context.checker);
  }
  return names;
}

function configForRenderCall(
  call: ts.CallExpression,
  resolveConfig: EtaInstanceConfigResolver,
): EtaInstanceConfig | undefined {
  return ts.isPropertyAccessExpression(call.expression)
    ? resolveConfig(call.expression.expression)
    : undefined;
}

function isEtaRenderCall(
  call: ts.CallExpression,
  methodName: string,
  checker: ts.TypeChecker,
  resolveConfig: EtaInstanceConfigResolver,
): boolean {
  if (ts.isIdentifier(call.expression)) {
    return (
      ETA_NAMED_TEMPLATE_RENDER_METHODS.has(methodName) &&
      (symbolComesFromEta(call.expression, checker) ||
        typeComesFromEta(call.expression, checker))
    );
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const receiver = call.expression.expression;
  return (
    configForRenderCall(call, resolveConfig) !== undefined ||
    symbolComesFromEta(receiver, checker) ||
    symbolComesFromEta(call.expression.name, checker) ||
    typeComesFromEta(receiver, checker) ||
    typeComesFromEta(call.expression.name, checker)
  );
}

function resolveStaticTemplateName(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): string | undefined {
  const nameExpression = call.arguments[0];
  if (!nameExpression) return undefined;
  return getStringLiteralValue(resolveStaticExpression(nameExpression, checker));
}

function recordLoadTemplateCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  config: EtaInstanceConfig | undefined,
): void {
  const templateName = resolveStaticTemplateName(call, checker);
  const templateExpression = call.arguments[1];
  if (templateName === undefined || !templateExpression) return;
  recordTemplateRegistration(
    templateName,
    templateExpression,
    checker,
    config,
  );
}

function recordNamedTemplateRenderCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  config: EtaInstanceConfig | undefined,
): void {
  const templateName = resolveStaticTemplateName(call, checker);
  const dataArgument = call.arguments[1];
  if (templateName === undefined || !dataArgument) return;
  recordRenderCallType(
    templateName,
    dataArgument,
    checker,
    sourceFile,
    config,
  );
}

function analyzeEtaCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  resolveConfig: EtaInstanceConfigResolver,
): void {
  const methodName = getCalledMethodName(call.expression);
  if (!methodName) return;

  if (methodName === "loadTemplate") {
    if (
      !ts.isPropertyAccessExpression(call.expression) ||
      !isEtaRenderCall(call, methodName, checker, resolveConfig)
    ) {
      return;
    }
    recordLoadTemplateCall(
      call,
      checker,
      configForRenderCall(call, resolveConfig),
    );
    return;
  }

  if (
    !ETA_NAMED_TEMPLATE_RENDER_METHODS.has(methodName) ||
    !isEtaRenderCall(call, methodName, checker, resolveConfig)
  ) {
    return;
  }
  recordNamedTemplateRenderCall(
    call,
    checker,
    sourceFile,
    configForRenderCall(call, resolveConfig),
  );
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
    collectTypeDataDefinitions(
      checker,
      type,
      [],
      dataArg,
      (dataPath, node) =>
        addTemplateDataDefinition(templateKey, dataPath, node),
    );
  } catch {
    // Type extraction failed for this call; skip it.
  }
}

function withLayoutBody(typeStr: string): string {
  return `__EtaOverride<${typeStr}, { body: string }>`;
}

function templateKeyFromPath(filePath: string): string {
  return canonicalTemplatePath(filePath);
}

function expressionToStructuralString(
  expression: ts.Expression,
  checker?: ts.TypeChecker,
): string | undefined {
  if (checker) {
    try {
      const type = checker.getTypeAtLocation(expression);
      const typeString = typeToStructuralString(checker, type);
      if (typeString !== "any" && typeString !== "unknown") return typeString;
    } catch {
      // Fall back to syntax-only inference below.
    }
  }
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
      return name && type
        ? [`${typePropertyName(name)}: ${type}`]
        : [];
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

interface VirtualTemplateAnalysis {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
}

function createVirtualTemplateAnalysis(
  fileName: string,
  content: string,
): VirtualTemplateAnalysis {
  const compilerOptions: ts.CompilerOptions = {
    ...DEFAULT_COMPILER_OPTIONS,
    strict: true,
  };
  const normalizedFileName = path.normalize(fileName);
  const host = ts.createCompilerHost(compilerOptions, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (candidate) =>
    path.normalize(candidate) === normalizedFileName || fileExists(candidate);
  host.readFile = (candidate) =>
    path.normalize(candidate) === normalizedFileName
      ? content
      : readFile(candidate);
  host.getSourceFile = (
    candidate,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    path.normalize(candidate) === normalizedFileName
      ? ts.createSourceFile(
          candidate,
          content,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        )
      : getSourceFile(
          candidate,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
  const program = ts.createProgram({
    rootNames: [fileName],
    options: compilerOptions,
    host,
  });
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`Unable to analyze ${fileName}`);
  return { checker: program.getTypeChecker(), sourceFile };
}

interface TemplateRelationshipContext {
  etaFile: string;
  sourceKey: string;
  sourceType: string;
  options: EtaLanguageOptions;
  resolution: EtaTemplateResolutionOptions | undefined;
  checker: ts.TypeChecker;
  virtualSourceFile: ts.SourceFile;
  bodyStart: number;
  sourceLength: number;
}

function addVirtualTemplateDataDefinition(
  context: TemplateRelationshipContext,
  templateKey: string,
  dataPath: string[],
  node: ts.Node,
): void {
  if (node.getSourceFile() !== context.virtualSourceFile) return;
  const start = node.getStart(context.virtualSourceFile) - context.bodyStart;
  if (start < 0 || start >= context.sourceLength) return;
  storeTemplateDataDefinition(templateKey, dataPath, {
    fileName: context.etaFile,
    start,
    length: Math.min(
      node.getWidth(context.virtualSourceFile),
      context.sourceLength - start,
    ),
  });
}

function recordExplicitDataDefinitions(
  context: TemplateRelationshipContext,
  templateKey: string,
  expression: ts.Expression,
): void {
  addVirtualTemplateDataDefinition(
    context,
    templateKey,
    [],
    expressionDefinitionNode(expression, context.checker),
  );
  const type = context.checker.getTypeAtLocation(expression);
  collectTypeDataDefinitions(
    context.checker,
    type,
    [],
    expression,
    (dataPath, node) =>
      addVirtualTemplateDataDefinition(context, templateKey, dataPath, node),
  );
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

function recordTemplateGraphEdge(sourceKey: string, targetKey: string): void {
  const sourceTargets = templateRelationshipMap.get(sourceKey) ?? new Set();
  sourceTargets.add(targetKey);
  templateRelationshipMap.set(sourceKey, sourceTargets);
  const targetSources = templateRelationshipMap.get(targetKey) ?? new Set();
  targetSources.add(sourceKey);
  templateRelationshipMap.set(targetKey, targetSources);
}

function getPropagatedRelationshipType(
  call: TemplateRelationshipCall,
  context: TemplateRelationshipContext,
): string {
  let propagatedType = context.sourceType;
  const dataArgument = call.arguments[1];
  if (dataArgument) {
    const explicitType = expressionToStructuralString(
      dataArgument,
      context.checker,
    );

    if (explicitType) {
      propagatedType = `__EtaOverride<${context.sourceType}, ${explicitType}>`;
    }
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
  recordTemplateGraphEdge(context.sourceKey, targetKey);

  mergeTemplateType(targetKey, getPropagatedRelationshipType(call, context));
  const dataArgument = call.arguments[1];
  const overriddenNames = dataArgument
    ? getOverriddenTopLevelNames(dataArgument, context)
    : new Set<string>();
  mergeTemplateDataDefinitions(
    targetKey,
    context.sourceKey,
    overriddenNames,
  );
  if (dataArgument) {
    recordExplicitDataDefinitions(context, targetKey, dataArgument);
  }
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
  const analysis = createVirtualTemplateAnalysis(
    virtualFileName,
    virtual.content,
  );
  const sourceFile = analysis.sourceFile;
  const sourceKey = templateKeyFromPath(etaFile);
  const context: TemplateRelationshipContext = {
    etaFile,
    sourceKey,
    sourceType,
    options,
    checker: analysis.checker,
    virtualSourceFile: sourceFile,
    bodyStart: virtual.bodyOffset,
    sourceLength: source.length,
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
function recordTemplateRegistration(
  name: string,
  templateExpression: ts.Expression,
  checker: ts.TypeChecker,
  config: EtaInstanceConfig | undefined,
): void {
  const resolved = resolveStaticExpression(templateExpression, checker);
  const sourceFile = resolved.getSourceFile();
  const isLiteral =
    ts.isStringLiteral(resolved) ||
    ts.isNoSubstitutionTemplateLiteral(resolved);
  const definitionNode = isLiteral
    ? resolved
    : expressionDefinitionNode(templateExpression, checker);
  const definitionSource = definitionNode.getSourceFile();
  const start = definitionNode.getStart(definitionSource) + (isLiteral ? 1 : 0);
  const length = Math.max(
    0,
    definitionNode.getWidth(definitionSource) - (isLiteral ? 2 : 0),
  );
  const registration: EtaTemplateRegistration = {
    name,
    fileName: isLiteral ? sourceFile.fileName : definitionSource.fileName,
    start,
    length,
  };
  const registrations = templateRegistrationMap.get(name) ?? [];
  if (
    !registrations.some(
      (existing) =>
        existing.fileName === registration.fileName &&
        existing.start === registration.start &&
        existing.length === registration.length,
    )
  ) {
    registrations.push(registration);
    templateRegistrationMap.set(name, registrations);
  }
  if (config) {
    setTemplateLanguageOptions(name, config.languageOptions);
    setTemplateResolutionOptions(name, {
      views: config.views,
      defaultExtension: config.defaultExtension,
    });
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
  const resolveConfig = collectEtaInstanceConfigs(sourceFile, checker);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      analyzeEtaCall(node, sourceFile, checker, resolveConfig);
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

function getWorkspaceAnalysisProjects(
  rootNames: string[],
  projects: WorkspaceProject[],
): WorkspaceProject[] {
  const configuredFiles = new Set<string>();
  for (const project of projects) {
    for (const fileName of project.rootNames) {
      configuredFiles.add(canonicalTemplatePath(fileName));
    }
  }

  const inferredFiles = new Map<WorkspaceProject | undefined, string[]>();
  for (const fileName of rootNames) {
    if (configuredFiles.has(canonicalTemplatePath(fileName))) continue;
    const project = findMostSpecificContainingRoot(fileName, projects);
    const projectFiles = inferredFiles.get(project);
    if (projectFiles) {
      projectFiles.push(fileName);
    } else {
      inferredFiles.set(project, [fileName]);
    }
  }
  if (inferredFiles.size === 0) return projects;

  const analysisProjects = [...projects];
  for (const [project, projectFiles] of inferredFiles) {
    analysisProjects.push({
      root: project?.root ?? process.cwd(),
      rootNames: projectFiles,
      options: {
        ...DEFAULT_COMPILER_OPTIONS,
        ...(project?.options ?? {}),
        allowJs: true,
        noEmit: true,
      },
    });
  }
  return analysisProjects;
}

export function analyzeWorkspaceFiles(
  rootNames: string[],
  hooks: WorkspaceAnalysisHooks = {},
  projects: WorkspaceProject[] = [],
): void {
  try {
    const configuredProjects = getWorkspaceAnalysisProjects(
      rootNames,
      projects,
    );
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
  return findMostSpecificContainingRoot(fileName, workspaceProjects);
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
export function areEtaTemplatesRelated(
  leftFileName: string,
  rightFileName: string,
): boolean {
  const left = canonicalTemplatePath(leftFileName);
  const right = canonicalTemplatePath(rightFileName);
  if (left === right) return true;
  const queue = [left, path.basename(left, path.extname(left))];
  const targets = new Set([
    right,
    path.basename(right, path.extname(right)),
  ]);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    if (targets.has(current)) return true;
    visited.add(current);
    for (const related of templateRelationshipMap.get(current) ?? []) {
      if (!visited.has(related)) queue.push(related);
    }
  }
  return false;
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
