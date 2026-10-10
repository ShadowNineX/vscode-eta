import * as ts from "typescript";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyNonDefaultEtaLanguageOptions,
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
  normalizeEtaLanguageOptions,
} from "./etaConfig";
import { buildVirtualDocument, DEFAULT_IT_TYPE } from "./virtualDocument";
import {
  getEtaCallPattern,
  getMemberName,
  getSimpleFactoryResult,
  getStaticStringValues,
  isConstDeclaration,
  isEtaModuleSpecifier,
} from "./etaUsage";
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
  /** The parsed config that provides this project's compiler context. */
  configFileName?: string;
  /** Resolved project references, retained for callers that watch configs. */
  projectReferences?: readonly ts.ProjectReference[];
}

export const workspaceProjects: WorkspaceProject[] = [];
/** Config files which affect the discovered workspace projects. */
export const workspaceProjectConfigFiles = new Set<string>();
/** The compiler context of a template's render source, including named configs. */
export const templateWorkspaceProjectMap = new Map<string, WorkspaceProject>();
let currentAnalysisProject: WorkspaceProject | undefined;
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

function readWorkspaceProject(
  configFile: string,
): WorkspaceProject | undefined {
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
    configFileName: configFile,
    projectReferences: parsed.projectReferences,
  };
}

const IGNORED_WORKSPACE_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  "build",
  ".vscode-test",
  "coverage",
  ".vitest",
]);

function isIgnoredWorkspacePath(fileName: string): boolean {
  return fileName
    .split(/[\\/]/)
    .some((part) => IGNORED_WORKSPACE_DIRECTORIES.has(part));
}

function isProjectConfigFile(fileName: string): boolean {
  const baseName = path.basename(fileName).toLowerCase();
  return (
    (baseName === "tsconfig.json" || baseName === "jsconfig.json") ||
    (baseName.startsWith("tsconfig.") && baseName.endsWith(".json")) ||
    (baseName.startsWith("jsconfig.") && baseName.endsWith(".json"))
  );
}

function resolveReferencedConfigFile(
  reference: ts.ProjectReference,
  fromConfigFile: string,
): string | undefined {
  const candidate = path.resolve(path.dirname(fromConfigFile), reference.path);
  if (ts.sys.fileExists(candidate)) return candidate;
  const namedCandidate = `${candidate}.json`;
  if (ts.sys.fileExists(namedCandidate)) return namedCandidate;
  const defaultCandidate = path.join(candidate, "tsconfig.json");
  return ts.sys.fileExists(defaultCandidate) ? defaultCandidate : undefined;
}

function collectExtendedConfigFiles(
  configFile: string,
  config: unknown,
  collected: Set<string>,
): void {
  const extendsValue =
    config && typeof config === "object" && "extends" in config
      ? (config as { extends?: unknown }).extends
      : undefined;
  const values = Array.isArray(extendsValue) ? extendsValue : [extendsValue];
  for (const value of values) {
    if (typeof value !== "string" || !value.startsWith(".")) continue;
    const candidate = path.resolve(path.dirname(configFile), value);
    const extendedConfig = ts.sys.fileExists(candidate)
      ? candidate
      : `${candidate}.json`;
    if (!ts.sys.fileExists(extendedConfig)) continue;
    const canonical = canonicalTemplatePath(extendedConfig);
    if (collected.has(canonical)) continue;
    collected.add(canonical);
    const loaded = ts.readConfigFile(extendedConfig, ts.sys.readFile);
    if (!loaded.error) {
      collectExtendedConfigFiles(extendedConfig, loaded.config, collected);
    }
  }
}

function scanWorkspaceProjects(configFiles: string[]): boolean {
  const pending = [...configFiles];
  const discovered = new Set<string>();
  let foundProject = false;
  while (pending.length > 0) {
    const configFile = pending.pop();
    if (!configFile) continue;
    const canonicalConfig = canonicalTemplatePath(configFile);
    if (discovered.has(canonicalConfig)) continue;
    discovered.add(canonicalConfig);
    const loaded = ts.readConfigFile(configFile, ts.sys.readFile);
    if (loaded.error) continue;
    workspaceProjectConfigFiles.add(canonicalConfig);
    collectExtendedConfigFiles(configFile, loaded.config, workspaceProjectConfigFiles);
    const project = readWorkspaceProject(configFile);
    if (!project) continue;
    foundProject = true;
    workspaceProjects.push(project);
    for (const reference of project.projectReferences ?? []) {
      const referencedConfig = resolveReferencedConfigFile(reference, configFile);
      if (referencedConfig) pending.push(referencedConfig);
    }
  }
  return foundProject;
}

/** Scan one workspace root and load its TypeScript project configuration. */
export function scanWorkspaceFiles(root: string): void {
  try {
    const sourceFiles = ts.sys.readDirectory(
      root,
      [...WORKSPACE_SCRIPT_EXTENSIONS],
      [...IGNORED_WORKSPACE_DIRECTORIES],
    );
    for (const fileName of sourceFiles) {
      if (!isIgnoredWorkspacePath(fileName)) workspaceTsFiles.add(fileName);
    }
    const etaFiles = ts.sys.readDirectory(
      root,
      [".eta"],
      [...IGNORED_WORKSPACE_DIRECTORIES],
    );
    for (const fileName of etaFiles) {
      if (!isIgnoredWorkspacePath(fileName)) workspaceEtaFiles.add(fileName);
    }

    const configFiles = ts.sys
      .readDirectory(root, [".json"], [...IGNORED_WORKSPACE_DIRECTORIES])
      .filter((fileName) =>
        !isIgnoredWorkspacePath(fileName) && isProjectConfigFile(fileName),
      );
    if (!scanWorkspaceProjects(configFiles)) {
      workspaceProjects.push({
        root,
        rootNames: sourceFiles,
        options: DEFAULT_COMPILER_OPTIONS,
      });
    }
  } catch {
    // Proceed without workspace context when the root is unreadable.
  }
}

// Methods whose first string argument names a file/cache template that can map
// back to a `.eta` document. `renderString*` remains excluded unless its source
// can be statically proven to be a Node fs read of an Eta file.
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
  if (f & ts.TypeFlags.ESSymbol) return "symbol";
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

function indexKeyType(type: ts.Type): string | undefined {
  if (type.flags & ts.TypeFlags.TemplateLiteral) {
    return typeToTemplateLiteralKey(type);
  }
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.ESSymbolLike) return "symbol";
  return undefined;
}

function typeToTemplateLiteralKey(type: ts.Type): string | undefined {
  const value = type as ts.TemplateLiteralType;
  if (!value.texts || !value.types) return undefined;
  return "`" + value.texts.map((text, index) =>
    escapeTemplateLiteralText(text) + (index < value.types.length ? "${" + templateLiteralPlaceholder(value.types[index]) + "}" : ""),
  ).join("") + "`";
}

function escapeTemplateLiteralText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function templateLiteralPlaceholder(type: ts.Type): string {
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.BigIntLike) return "bigint";
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  return "string";
}

function expandIndexInfos(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number,
  boundTypeParameters: ReadonlySet<string>,
): string[] {
  return checker.getIndexInfosOfType(type).flatMap((info) => {
    const key = indexKeyType(info.keyType);
    if (!key) return [];
    const readonly = info.isReadonly ? "readonly " : "";
    const value = typeToStructuralString(checker, info.type, depth + 1, boundTypeParameters);
    return [`${readonly}[key: ${key}]: ${value}`];
  });
}

function expandNamedProperties(
  checker: ts.TypeChecker,
  type: ts.Type,
  props: readonly ts.Symbol[],
  depth: number,
  boundTypeParameters: ReadonlySet<string>,
): string[] {
  const syntheticReadonlyNames = readonlyPropertyNames(checker, type);
  return props.filter((prop) => !symbolIsNonPublic(prop)).map((prop) => {
    const optional = prop.flags & ts.SymbolFlags.Optional ? "?" : "";
    const readonly = symbolIsReadonly(prop, syntheticReadonlyNames) ? "readonly " : "";
    try {
      const propStr = typeToStructuralString(checker, checker.getTypeOfSymbol(prop), depth + 1, boundTypeParameters);
      return `${readonly}${typePropertyName(prop.name)}${optional}: ${propStr}`;
    } catch {
      return `${readonly}${typePropertyName(prop.name)}${optional}: unknown`;
    }
  });
}

function symbolIsNonPublic(symbol: ts.Symbol): boolean {
  return symbol.declarations?.some((declaration) =>
    declarationHasPrivateName(declaration) ||
    (ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    )),
  ) ?? false;
}

function declarationHasPrivateName(declaration: ts.Declaration): boolean {
  return "name" in declaration && ts.isPrivateIdentifier(declaration.name as ts.Node);
}

function syntheticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function readonlyPropertyNames(checker: ts.TypeChecker, type: ts.Type): ReadonlySet<string> {
  const node = checker.typeToTypeNode(type, undefined, ts.NodeBuilderFlags.InTypeAlias);
  if (!node || !ts.isTypeLiteralNode(node)) return new Set();
  return new Set(node.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || !member.name || !ts.canHaveModifiers(member)) return [];
    const name = syntheticPropertyName(member.name);
    return name && ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
      ? [name]
      : [];
  }));
}

function symbolIsReadonly(symbol: ts.Symbol, syntheticReadonlyNames: ReadonlySet<string>): boolean {
  if (syntheticReadonlyNames.has(symbol.name)) return true;
  const declarations = symbol.declarations ?? [];
  if (declarations.some(ts.isSetAccessorDeclaration)) return false;
  return declarations.some((declaration) =>
    ts.isGetAccessorDeclaration(declaration) ||
    (ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)),
  ) ?? false;
}

/** Expands an object/interface type into `{ prop: type; ... }` notation. */
function expandObjectType(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number,
  boundTypeParameters: ReadonlySet<string>,
): string {
  const props = checker.getPropertiesOfType(type);
  const parts = [
    ...expandNamedProperties(checker, type, props, depth, boundTypeParameters),
    ...expandIndexInfos(checker, type, depth, boundTypeParameters),
  ];
  return parts.length === 0 ? "Record<string, unknown>" : `{ ${parts.join("; ")} }`;
}

/**
 * Recursively convert a TypeScript `Type` to a self-contained structural type
 * string that is safe to embed in `declare const it: <here>`.
 */
export function typeToStructuralString(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth = 0,
  boundTypeParameters: ReadonlySet<string> = new Set(),
): string {
  if (depth > MAX_TYPE_DEPTH) return "unknown";

  if (type.isUnion()) {
    const unique = [
      ...new Set(
        type.types.map((t) => typeToStructuralString(checker, t, depth + 1, boundTypeParameters)),
      ),
    ];
    return unique.join(" | ");
  }

  if (type.isIntersection()) {
    return type.types
      .map((t) => typeToStructuralString(checker, t, depth + 1, boundTypeParameters))
      .join(" & ");
  }

  const primitive = primitiveFromFlags(type.flags);
  if (primitive !== undefined) return primitive;

  const literal = literalTypeToString(type);
  if (literal !== undefined) return literal;
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const name = checker.typeToString(type);
    if (boundTypeParameters.has(name)) return name;
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint !== type
      ? typeToStructuralString(checker, constraint, depth + 1, boundTypeParameters)
      : "unknown";
  }

  if (checker.isArrayType(type)) return expandArrayType(checker, type, depth, boundTypeParameters);

  if (checker.isTupleType(type)) {
    return expandTupleType(checker, type as ts.TupleTypeReference, depth, boundTypeParameters);
  }

  return expandCallableType(checker, type, depth, boundTypeParameters) ??
    expandObjectType(checker, type, depth, boundTypeParameters);
}

function expandArrayType(checker: ts.TypeChecker, type: ts.Type, depth: number, boundTypeParameters: ReadonlySet<string>): string {
  const elementType = checker.getTypeArguments(type as ts.TypeReference)[0];
  const element = elementType ? typeToStructuralString(checker, elementType, depth + 1, boundTypeParameters) : "unknown";
  return isReadonlyArrayType(checker, type) ? `ReadonlyArray<${element}>` : `Array<${element}>`;
}

function isReadonlyArrayType(checker: ts.TypeChecker, type: ts.Type): boolean {
  const reference = type as ts.TypeReference;
  return [reference.target?.symbol?.name, type.symbol?.name].includes("ReadonlyArray") ||
    checker.typeToString(type).startsWith("readonly ");
}

function expandTupleType(
  checker: ts.TypeChecker,
  type: ts.TupleTypeReference,
  depth: number,
  boundTypeParameters: ReadonlySet<string>,
): string {
  const elements = checker.getTypeArguments(type).map((element, index) => {
    const value = typeToStructuralString(checker, element, depth + 1, boundTypeParameters);
    const flags = type.target.elementFlags[index];
    if (flags & ts.ElementFlags.Optional) return `(${value})?`;
    if (flags & ts.ElementFlags.Rest) return `...Array<${value}>`;
    if (flags & ts.ElementFlags.Variadic) return `...${value}`;
    return value;
  });
  return `${type.target.readonly ? "readonly " : ""}[${elements.join(", ")}]`;
}

function expandCallableType(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number,
  boundTypeParameters: ReadonlySet<string>,
): string | undefined {
  const callSignatures = type.getCallSignatures();
  const constructSignatures = type.getConstructSignatures();
  if (callSignatures.length > 0 || constructSignatures.length > 0) {
    const entries = [
      ...constructSignatures.filter(isAccessibleConstructSignature).map((signature) => ({ signature, construct: true })),
      ...callSignatures.map((signature) => ({ signature, construct: false })),
    ];
    const properties = checker.getPropertiesOfType(type);
    const hasObjectMembers = properties.length > 0 || checker.getIndexInfosOfType(type).length > 0;
    const asFunction = entries.length === 1 && !entries[0].construct && !hasObjectMembers;
    const signatures = entries.map(({ signature, construct }) => {
      const localParameters = new Set(boundTypeParameters);
      for (const parameter of signature.typeParameters ?? []) localParameters.add(checker.typeToString(parameter));
      const generics = signature.typeParameters?.map((parameter) => {
        const constraint = parameter.getConstraint();
        const defaultType = parameter.getDefault();
        return checker.typeToString(parameter) +
          (constraint ? ` extends ${typeToStructuralString(checker, constraint, depth + 1, localParameters)}` : "") +
          (defaultType ? ` = ${typeToStructuralString(checker, defaultType, depth + 1, localParameters)}` : "");
      });
      const genericPrefix = generics?.length ? `<${generics.join(", ")}>` : "";
      const parameters = signature.getParameters().map((parameter, index) => {
        const declaration = definitionNodeForSymbol(parameter);
        const location =
          declaration ?? parameter.valueDeclaration ?? parameter.declarations?.[0];
        const parameterType = location
          ? checker.getTypeOfSymbolAtLocation(parameter, location)
          : undefined;
        const parameterDeclaration = parameter.declarations?.find(ts.isParameter);
        const rest = parameterDeclaration?.dotDotDotToken ? "..." : "";
        const optional = !rest && (parameter.flags & ts.SymbolFlags.Optional ||
          parameterDeclaration && (parameterDeclaration.questionToken || parameterDeclaration.initializer)) ? "?" : "";
        const name = /^[$A-Z_a-z][$\w]*$/.test(parameter.name) ? parameter.name : `arg${index}`;
        return `${rest}${name}${optional}: ${
          parameterType
            ? typeToStructuralString(checker, parameterType, depth + 1, localParameters)
            : "unknown"
        }`;
      });
      return `${construct ? "new " : ""}${genericPrefix}(${parameters.join(", ")})${asFunction ? " =>" : ":"} ${typeToStructuralString(
        checker,
        signature.getReturnType(),
        depth + 1,
        localParameters,
      )}`;
    });
    const signaturesType = asFunction ? signatures[0] : `{ ${signatures.join("; ")} }`;
    return hasObjectMembers
      ? `${signaturesType} & ${expandObjectType(checker, type, depth, boundTypeParameters)}`
      : signaturesType;
  }

  return undefined;
}

function isAccessibleConstructSignature(signature: ts.Signature): boolean {
  const declaration = signature.declaration;
  if (!declaration) return true;
  if (ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword || modifier.kind === ts.SyntaxKind.AbstractKeyword,
  )) return false;
  const parent = declaration.parent;
  return !ts.isClassLike(parent) || !ts.getModifiers(parent)?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword);
}

function getCalledMethodName(expr: ts.Expression): string | undefined {
  const member = getMemberName(expr);
  if (member) return member;
  if (ts.isIdentifier(expr)) return expr.text;
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
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === propertyName) return property.name;
      continue;
    }
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
      ts.isParameter(declaration))
  ) {
    initializer = ts.isVariableDeclaration(declaration) && !isConstDeclaration(declaration) ||
      ts.isParameter(declaration) ? undefined : declaration.initializer;
  } else if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
    const valueSymbol = checker.getShorthandAssignmentValueSymbol(declaration);
    const valueDeclaration =
      valueSymbol?.valueDeclaration ?? valueSymbol?.declarations?.[0];
    if (valueDeclaration && ts.isVariableDeclaration(valueDeclaration) && isConstDeclaration(valueDeclaration)) {
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
  const component = getStaticPathComponent(expr, sourceFile, checker);
  if (component === undefined || !path.isAbsolute(component)) return undefined;
  return path.normalize(component);
}

function getStaticPathComponent(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
): string | undefined {
  const resolved = checker ? resolveStaticExpression(expr, checker) : expr;
  if (resolved !== expr) {
    return getStaticPathComponent(resolved, resolved.getSourceFile(), checker);
  }
  const literal = getStringLiteralValue(expr);
  if (literal !== undefined) return literal;
  if (ts.isIdentifier(expr) && expr.text === "__dirname") {
    if (checker?.getSymbolAtLocation(expr)?.declarations?.some((declaration) => !declaration.getSourceFile().isDeclarationFile)) {
      return undefined;
    }
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
    checker && ["join", "resolve"].includes(getNodeModuleMethodName(expr.expression, checker, "path") ?? "")
  ) {
    return getJoinedPathComponent(expr, sourceFile, checker);
  }
  return undefined;
}

function getJoinedPathComponent(expr: ts.CallExpression, sourceFile: ts.SourceFile, checker: ts.TypeChecker): string | undefined {
  const parts = expr.arguments.map((argument) => getStaticPathComponent(argument, sourceFile, checker));
  if (parts.includes(undefined)) return undefined;
  const resolvedParts = parts as string[];
  if (getNodeModuleMethodName(expr.expression, checker, "path") === "resolve") {
    if (!resolvedParts.some((part) => path.isAbsolute(part))) return undefined;
    return path.resolve(path.dirname(sourceFile.fileName), ...resolvedParts);
  }
  return path.join(...resolvedParts);
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
  sourceFile = expr?.getSourceFile(),
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
    views: viewsExpression && sourceFile
      ? getStaticPathValue(viewsExpression, sourceFile, checker)
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
      isEtaModuleSpecifier(current.moduleSpecifier.text)
    ) {
      return true;
    }
    if (
      ts.isImportEqualsDeclaration(current) &&
      ts.isExternalModuleReference(current.moduleReference) &&
      current.moduleReference.expression &&
      ts.isStringLiteral(current.moduleReference.expression) &&
      isEtaModuleSpecifier(current.moduleReference.expression.text)
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

function isGlobalRequire(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== "require") {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) return false;
  return !symbol.declarations?.some(
    (declaration) =>
      ts.isParameter(declaration) ||
      (ts.isVariableDeclaration(declaration) && !declaration.getSourceFile().isDeclarationFile) ||
      (ts.isFunctionDeclaration(declaration) &&
        !declaration.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
        )),
  );
}

function isEtaRequireCall(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return (
    ts.isCallExpression(expression) &&
    isGlobalRequire(expression.expression, checker) &&
    expression.arguments.length === 1 &&
    isEtaModuleSpecifier(getStringLiteralValue(expression.arguments[0]) ?? "")
  );
}

const ETA_REQUIRE_MEMBERS = new Set([
  "Eta",
  "loadTemplate",
  "renderString",
  "renderStringAsync",
  ...ETA_NAMED_TEMPLATE_RENDER_METHODS,
]);

function expressionComesFromEtaRequire(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return expressionComesFromEtaRequire(expression.expression, checker, seen);
  }
  if (isEtaRequireCall(expression, checker)) return true;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return (
      ETA_REQUIRE_MEMBERS.has(getMemberName(expression) ?? "") &&
      expressionComesFromEtaRequire(expression.expression, checker, seen)
    );
  }
  if (!ts.isIdentifier(expression)) return false;

  let symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  let declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (
    declaration &&
    !ts.isVariableDeclaration(declaration) &&
    !ts.isBindingElement(declaration) &&
    symbol.flags & ts.SymbolFlags.Alias
  ) {
    symbol = checker.getAliasedSymbol(symbol);
    declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  }
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
    if (!isConstDeclaration(declaration)) return false;
    return expressionComesFromEtaRequire(declaration.initializer, checker, seen);
  }
  if (!declaration || !ts.isBindingElement(declaration)) {
    return hasStaticEtaRequireBinding(expression, checker);
  }
  return bindingElementComesFromEtaRequire(declaration, checker, seen) || hasStaticEtaRequireBinding(expression, checker);
}

function bindingElementComesFromEtaRequire(declaration: ts.BindingElement, checker: ts.TypeChecker, seen: Set<ts.Symbol>): boolean {
  const bindingPattern = declaration.parent;
  const variableDeclaration = bindingPattern.parent;
  if (
    !ts.isObjectBindingPattern(bindingPattern) ||
    !ts.isVariableDeclaration(variableDeclaration) ||
    !variableDeclaration.initializer || !isConstDeclaration(variableDeclaration)
  ) {
    return false;
  }
  let propertyName = declaration.propertyName
    ? getPropertyName(declaration.propertyName)
    : undefined;
  if (!propertyName && ts.isIdentifier(declaration.name)) propertyName = declaration.name.text;
  return (
    propertyName !== undefined &&
    ETA_REQUIRE_MEMBERS.has(propertyName) &&
    expressionComesFromEtaRequire(variableDeclaration.initializer, checker, seen)
  );
}

function hasStaticEtaRequireBinding(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  let nearest: ts.VariableDeclaration | undefined;
  const useStart = identifier.getStart(identifier.getSourceFile());
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name) &&
      node.getSourceFile() === identifier.getSourceFile() &&
      node.getStart() <= useStart
    ) {
      for (const element of node.name.elements) {
        if (
          ts.isIdentifier(element.name) &&
          checker.getSymbolAtLocation(element.name) === checker.getSymbolAtLocation(identifier) &&
          isConstDeclaration(node) &&
          (!nearest || node.getStart() > nearest.getStart())
        ) {
          nearest = node;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(identifier.getSourceFile());
  if (!nearest || !ts.isObjectBindingPattern(nearest.name)) return false;
  const element = nearest.name.elements.find(
    (candidate) =>
      ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text,
  );
  let propertyName = element?.propertyName
    ? getPropertyName(element.propertyName)
    : undefined;
  if (!propertyName && element && ts.isIdentifier(element.name)) propertyName = element.name.text;
  return (
    propertyName !== undefined &&
    ETA_REQUIRE_MEMBERS.has(propertyName) &&
    expressionComesFromEtaRequire(nearest.initializer!, checker)
  );
}

function declarationComesFromNodeModule(declaration: ts.Declaration, moduleName: string): boolean {
  const normalizedFileName = declaration
    .getSourceFile()
    .fileName.replaceAll("\\", "/");
  if (normalizedFileName.includes(`/@types/node/${moduleName}.`) ||
      normalizedFileName.includes(`/@types/node/${moduleName}/`)) return true;
  let current: ts.Node | undefined = declaration;
  while (current) {
    if (
      ts.isImportDeclaration(current) &&
      ts.isStringLiteral(current.moduleSpecifier) &&
      [moduleName, `node:${moduleName}`, `${moduleName}/promises`, `node:${moduleName}/promises`].includes(current.moduleSpecifier.text)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function symbolComesFromNodeModule(
  node: ts.Node,
  checker: ts.TypeChecker,
  moduleName: string,
): boolean {
  if (ts.isPropertyAccessExpression(node)) node = node.name;
  else if (ts.isElementAccessExpression(node)) node = node.argumentExpression;
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return false;
  if (symbol.declarations?.some((declaration) => declarationComesFromNodeModule(declaration, moduleName))) return true;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol.declarations?.some((declaration) => declarationComesFromNodeModule(declaration, moduleName)) ?? false;
}

function getNodeModuleMethodName(expression: ts.Expression, checker: ts.TypeChecker, moduleName: string): string | undefined {
  if (!symbolComesFromNodeModule(expression, checker, moduleName)) {
    return getRequiredNodeModuleMember(expression, checker, moduleName);
  }
  const node = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  let symbol = checker.getSymbolAtLocation(node);
  const imported = symbol?.declarations?.find(ts.isImportSpecifier);
  if (imported) return (imported.propertyName ?? imported.name).text;
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations?.length ? symbol.name : getCalledMethodName(expression);
}

function getRequiredNodeModuleMember(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  moduleName: string,
  seen = new Set<ts.Symbol>(),
): string | undefined {
  const isModule = (value: ts.Expression): boolean => {
    const resolved = resolveStaticExpression(value, checker);
    return ts.isCallExpression(resolved) && isGlobalRequire(resolved.expression, checker) &&
      resolved.arguments.length === 1 &&
      [moduleName, `node:${moduleName}`, `${moduleName}/promises`, `node:${moduleName}/promises`]
        .includes(getStringLiteralValue(resolved.arguments[0]) ?? "");
  };
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return isModule(expression.expression) ? getMemberName(expression) : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration && ts.isVariableDeclaration(declaration) && isConstDeclaration(declaration) && declaration.initializer) {
    return getRequiredNodeModuleMember(declaration.initializer, checker, moduleName, seen);
  }
  if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) &&
      ts.isVariableDeclaration(declaration.parent.parent) && isConstDeclaration(declaration.parent.parent) &&
      declaration.parent.parent.initializer && isModule(declaration.parent.parent.initializer)) {
    const name = declaration.propertyName ?? declaration.name;
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
  }
  return undefined;
}

function isNodeFsReadCall(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): expression is ts.CallExpression {
  if (!ts.isCallExpression(expression)) return false;
  const called = expression.expression;
  const name = getNodeModuleMethodName(called, checker, "fs");
  return (
    name === "readFile" || name === "readFileSync"
  );
}

function isImportMetaUrl(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "url" &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function getStaticEtaFilePath(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  resolveConfig?: EtaInstanceConfigResolver,
): string | undefined {
  if (ts.isAwaitExpression(expression)) {
    return getStaticEtaFilePath(expression.expression, sourceFile, checker, resolveConfig);
  }
  const resolved = resolveStaticExpression(expression, checker);
  if (resolved !== expression) {
    return getStaticEtaFilePath(resolved, resolved.getSourceFile(), checker, resolveConfig);
  }
  const etaRead = isEtaReadCall(expression, resolveConfig);
  if ((!isNodeFsReadCall(expression, checker) && !etaRead) ||
      !ts.isCallExpression(expression) || expression.arguments.length === 0) {
    return undefined;
  }
  let target = resolveStaticExpression(expression.arguments[0], checker);
  if (ts.isCallExpression(target) && getNodeModuleMethodName(target.expression, checker, "url") === "fileURLToPath" && target.arguments[0]) {
    target = resolveStaticExpression(target.arguments[0], checker);
  }
  const filePath = getReadTargetPath(target, sourceFile, checker, resolveConfig);
  return filePath && path.extname(filePath).toLowerCase() === ".eta"
    ? canonicalTemplatePath(filePath)
    : undefined;
}

function isEtaReadCall(
  expression: ts.Expression,
  resolveConfig?: EtaInstanceConfigResolver,
): boolean {
  return ts.isCallExpression(expression) && getMemberName(expression.expression) === "readFile" &&
    (ts.isPropertyAccessExpression(expression.expression) || ts.isElementAccessExpression(expression.expression)) &&
    resolveConfig?.(expression.expression.expression) !== undefined;
}

function getReadTargetPath(
  target: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  resolveConfig?: EtaInstanceConfigResolver,
): string | undefined {
  if (ts.isCallExpression(target) && getMemberName(target.expression) === "resolvePath" &&
      (ts.isPropertyAccessExpression(target.expression) || ts.isElementAccessExpression(target.expression))) {
    const config = resolveConfig?.(target.expression.expression);
    const names = target.arguments[0] && getStaticStringValues(target.arguments[0], checker,
      (value) => resolveStaticExpression(value, checker));
    if (config?.views && names?.length === 1) {
      return resolveTemplatePath(names[0], { fromFile: sourceFile.fileName,
        views: config.views, defaultExtension: config.defaultExtension, templateFiles: workspaceEtaFiles });
    }
    return undefined;
  }
  if (
    ts.isNewExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "URL" &&
    target.arguments?.length === 2 &&
    isImportMetaUrl(target.arguments[1])
  ) {
    const relativePath = getStringLiteralValue(target.arguments[0]);
    if (relativePath !== undefined) {
      try {
        return fileURLToPath(new URL(relativePath, pathToFileURL(sourceFile.fileName)));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  // Node and Eta reads resolve relative paths against runtime cwd, which the
  // editor cannot infer. Only use paths with an explicit filesystem anchor.
  const component = getStaticPathComponent(target, sourceFile, checker);
  return component && path.isAbsolute(component) ? component : undefined;
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
      typeComesFromEta(expr.expression, checker) ||
      expressionComesFromEtaRequire(expr.expression, checker))
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
  const resolvingExpressions = new Set<ts.Expression>();

  function getExpressionSymbol(
    expression: ts.Expression,
  ): ts.Symbol | undefined {
    let symbolNode: ts.Node | undefined;
    if (ts.isPropertyAccessExpression(expression)) symbolNode = expression.name;
    else if (ts.isIdentifier(expression)) symbolNode = expression;
    if (!symbolNode) return undefined;
    let symbol = checker.getSymbolAtLocation(symbolNode);
    if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  }

  function configForExpression(
    expression: ts.Expression,
    provenance = expression.getSourceFile(),
  ): EtaInstanceConfig | undefined {
    if (resolvingExpressions.has(expression)) return undefined;
    const symbol = getExpressionSymbol(expression);
    if (symbol) {
      const existing = configs.get(symbol);
      if (existing) return existing;
      if (resolving.has(symbol)) return undefined;
      resolving.add(symbol);
    }
    resolvingExpressions.add(expression);

    const config = resolveUncachedConfig(expression, provenance);
    if (symbol) {
      resolving.delete(symbol);
      if (config) configs.set(symbol, config);
    }
    resolvingExpressions.delete(expression);
    return config;
  }

  function resolveUncachedConfig(
    expression: ts.Expression,
    provenance: ts.SourceFile,
  ): EtaInstanceConfig | undefined {
    let config: EtaInstanceConfig | undefined;
    const resolved = resolveStaticExpression(expression, checker);
    if (resolved !== expression) {
      config = configForExpression(resolved, provenance);
    } else if (isNewEtaExpression(expression, checker)) {
      config = getEtaInstanceConfigFromExpression(
        expression.arguments?.[0],
        checker,
        provenance,
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
    } else {
      const result = getSimpleFactoryResult(expression, checker, (value) => resolveStaticExpression(value, checker));
      if (result) {
        config = result.configExpression
          ? (() => {
            let nestedExpression = result.configExpression;
            let nestedSourceFile = result.sourceFile;
            for (let depth = 0; depth < MAX_FORWARDING_DEPTH; depth++) {
              const nested = getSimpleFactoryResult(
                nestedExpression,
                checker,
                (value) => resolveStaticExpression(value, checker),
              );
              if (!nested) break;
              nestedExpression = nested.expression;
              nestedSourceFile = nested.sourceFile;
            }
            return getEtaInstanceConfigFromExpression(
              nestedExpression,
              checker,
              nestedSourceFile,
            );
          })()
          : configForExpression(result.expression, result.sourceFile);
      } else if (typeComesFromEta(expression, checker)) {
        config = {
          languageOptions: DEFAULT_ETA_LANGUAGE_OPTIONS,
          defaultExtension: ".eta",
        };
      }
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
      node.initializer && isConstDeclaration(node)
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

interface FiniteRecordRenderPair {
  name: string;
  data: ts.Expression;
}

function getFiniteRecordRenderPairs(
  nameArgument: ts.Expression,
  dataArgument: ts.Expression,
  checker: ts.TypeChecker,
): FiniteRecordRenderPair[] | undefined {
  function indexedProperty(expression: ts.Expression, property: string): ts.ElementAccessExpression | undefined {
    return ts.isPropertyAccessExpression(expression) &&
      expression.name.text === property &&
      ts.isElementAccessExpression(expression.expression) &&
      expression.expression.argumentExpression
      ? expression.expression
      : undefined;
  }
  const named = indexedProperty(nameArgument, "template");
  const data = indexedProperty(dataArgument, "data");
  if (!named || !data) return undefined;
  const recordSymbol = checker.getSymbolAtLocation(named.expression);
  const dataRecordSymbol = checker.getSymbolAtLocation(data.expression);
  const keySymbol = checker.getSymbolAtLocation(named.argumentExpression!);
  const dataKeySymbol = checker.getSymbolAtLocation(data.argumentExpression!);
  if (!recordSymbol || recordSymbol !== dataRecordSymbol ||
      !keySymbol || keySymbol !== dataKeySymbol) return undefined;
  const record = resolveStaticExpression(named.expression, checker);
  if (!ts.isObjectLiteralExpression(record)) return undefined;
  const keys = getStaticStringValues(named.argumentExpression!, checker, (value) => resolveStaticExpression(value, checker));
  if (!keys) return undefined;
  const pairs: FiniteRecordRenderPair[] = [];
  for (const key of keys) {
    const entry = getObjectProperty(record, key);
    if (!entry || !ts.isObjectLiteralExpression(entry)) return undefined;
    const template = getObjectProperty(entry, "template");
    const entryData = getObjectProperty(entry, "data");
    const names = template && getStaticStringValues(template, checker, (value) => resolveStaticExpression(value, checker));
    if (!names || !entryData) return undefined;
    for (const name of names) pairs.push({ name, data: entryData });
  }
  return pairs;
}

const MAX_FORWARDING_DEPTH = 8;

function callTargetSymbol(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  let symbolNode: ts.Node | undefined;
  if (ts.isPropertyAccessExpression(call.expression)) symbolNode = call.expression.name;
  else if (ts.isIdentifier(call.expression)) symbolNode = call.expression;
  if (!symbolNode) return undefined;
  let symbol = checker.getSymbolAtLocation(symbolNode);
  if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function functionDeclarationForCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration | undefined {
  const symbol = callTargetSymbol(call, checker);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return undefined;
  return functionFromConstDeclaration(declaration, checker) ??
    functionFromExportAssignment(declaration, call, checker) ??
    callableDeclaration(declaration, true);
}

function callableDeclaration(
  declaration: ts.Node | undefined,
  allowMethod = false,
): ts.FunctionLikeDeclaration | undefined {
  return declaration && (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration) ||
    allowMethod && ts.isMethodDeclaration(declaration)
  ) ? declaration as ts.FunctionLikeDeclaration : undefined;
}

function functionFromConstDeclaration(
  declaration: ts.Node,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration | undefined {
  if (
    ts.isVariableDeclaration(declaration) &&
    isConstDeclaration(declaration) &&
    declaration.initializer
  ) {
    if (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer)) {
      return declaration.initializer;
    }
    if (ts.isPropertyAccessExpression(declaration.initializer)) {
      const member = checker.getSymbolAtLocation(declaration.initializer.name);
      const memberDeclaration = member?.valueDeclaration ?? member?.declarations?.[0];
      return callableDeclaration(memberDeclaration, true);
    }
  }
  return undefined;
}

function functionFromExportAssignment(
  declaration: ts.Node,
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration | undefined {
  if (ts.isExportAssignment(declaration) && ts.isObjectLiteralExpression(declaration.expression) &&
      ts.isPropertyAccessExpression(call.expression)) {
    const memberName = call.expression.name.text;
    const property = declaration.expression.properties.find((item) =>
      ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === memberName,
    );
    if (property && ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
      const target = checker.getSymbolAtLocation(property.initializer);
      const targetDeclaration = target?.valueDeclaration ?? target?.declarations?.[0];
      return callableDeclaration(targetDeclaration);
    }
  }
  return undefined;
}

function getForwardingBindings(
  declaration: ts.FunctionLikeDeclaration,
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): Map<ts.Symbol, ts.Expression> | undefined {
  if (declaration.parameters.some((parameter) => parameter.dotDotDotToken)) return undefined;
  if (call.arguments.length > declaration.parameters.length) return undefined;
  const bindings = new Map<ts.Symbol, ts.Expression>();
  for (let index = 0; index < declaration.parameters.length; index++) {
    const parameter = declaration.parameters[index];
    if (!ts.isIdentifier(parameter.name)) return undefined;
    const value = call.arguments[index] ?? parameter.initializer;
    if (!value) return undefined;
    const symbol = checker.getSymbolAtLocation(parameter.name);
    if (!symbol) return undefined;
    bindings.set(symbol, value);
  }
  return bindings;
}

function substituteForwardedExpression(
  expression: ts.Expression,
  bindings: ReadonlyMap<ts.Symbol, ts.Expression>,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ts.Expression {
  if (!ts.isIdentifier(expression)) return expression;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return expression;
  seen.add(symbol);
  const bound = bindings.get(symbol);
  if (bound) return substituteForwardedExpression(bound, bindings, checker, seen);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    isConstDeclaration(declaration) &&
    declaration.initializer
  ) {
    return substituteForwardedExpression(declaration.initializer, bindings, checker, seen);
  }
  return expression;
}

function getForwardedCalls(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  depth = 0,
  seen = new Set<ts.Symbol>(),
): ts.CallExpression[] {
  if (depth >= MAX_FORWARDING_DEPTH) return [];
  const declaration = functionDeclarationForCall(call, checker);
  if (!declaration || declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      ((ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) && declaration.asteriskToken)) {
    return [call];
  }
  const functionSymbol = callTargetSymbol(call, checker) ??
    (declaration.name && checker.getSymbolAtLocation(declaration.name));
  if (functionSymbol && seen.has(functionSymbol)) return [];
  const bindings = getForwardingBindings(declaration, call, checker);
  if (!bindings || !declaration.body) return [call];
  const inner = getWrapperBodyCall(declaration.body);
  if (!inner) return [call];
  const transformed = createForwardedCall(inner, bindings, checker);
  return getForwardedCalls(transformed, checker, depth + 1, functionSymbol ? new Set([...seen, functionSymbol]) : seen);
}

function getWrapperBodyCall(body: ts.ConciseBody): ts.CallExpression | undefined {
  if (!ts.isBlock(body)) return ts.isCallExpression(body) ? body : undefined;
  const calls: ts.CallExpression[] = [];
  for (const statement of body.statements) {
    if (ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
          statement.declarationList.declarations.some((item) => !item.initializer)) return undefined;
      continue;
    }
    let expression: ts.Expression | undefined;
    if (ts.isExpressionStatement(statement) || ts.isReturnStatement(statement)) {
      expression = statement.expression;
    }
    if (!expression || !ts.isCallExpression(expression)) return undefined;
    calls.push(expression);
  }
  return calls.length === 1 ? calls[0] : undefined;
}

function createForwardedCall(
  inner: ts.CallExpression,
  bindings: ReadonlyMap<ts.Symbol, ts.Expression>,
  checker: ts.TypeChecker,
): ts.CallExpression {
  const expression = ts.isPropertyAccessExpression(inner.expression)
    ? ts.factory.updatePropertyAccessExpression(
      inner.expression,
      substituteForwardedExpression(inner.expression.expression, bindings, checker),
      inner.expression.name,
    )
    : inner.expression;
  return ts.factory.updateCallExpression(
    inner,
    expression,
    inner.typeArguments,
    inner.arguments.map((argument) => substituteForwardedExpression(argument, bindings, checker)),
  );
}

function analyzeEtaCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  resolveConfig: EtaInstanceConfigResolver,
): void {
  const forwarded = getForwardedCalls(call, checker);
  if (forwarded.length === 1 && forwarded[0] !== call) {
    analyzeEtaCall(forwarded[0], sourceFile, checker, resolveConfig);
    return;
  }
  const resolve = (value: ts.Expression) => resolveStaticExpression(value, checker);
  const pattern = getEtaCallPattern(call, checker, resolve);
  if (!pattern?.methodName || !ETA_REQUIRE_MEMBERS.has(pattern.methodName)) return;
  if (!isSupportedEtaCallPattern(call, pattern, checker, resolveConfig)) return;
  const receiver = pattern.boundReceiver ?? pattern.receiver;
  const config = receiver ? resolveConfig(receiver) : undefined;
  recordEtaCallPattern(pattern, sourceFile, checker, resolveConfig, config);
}

function isSupportedEtaCallPattern(
  call: ts.CallExpression,
  pattern: NonNullable<ReturnType<typeof getEtaCallPattern>>,
  checker: ts.TypeChecker,
  resolveConfig: EtaInstanceConfigResolver,
): boolean {
  const isEtaReceiver = (receiver: ts.Expression) =>
    resolveConfig(receiver) !== undefined || symbolComesFromEta(receiver, checker) ||
    typeComesFromEta(receiver, checker) || expressionComesFromEtaRequire(receiver, checker);
  if (!(pattern.receiver && isEtaReceiver(pattern.receiver)) &&
      !symbolComesFromEta(pattern.method, checker) &&
      !typeComesFromEta(pattern.method, checker) &&
      !expressionComesFromEtaRequire(pattern.method, checker)) return false;
  if (pattern.boundReceiver && !isEtaReceiver(pattern.boundReceiver)) return false;
  // Instance methods use `this`; an extracted method needs an explicit receiver.
  if (ts.isIdentifier(call.expression) && pattern.receiver &&
      typeComesFromEta(pattern.receiver, checker) &&
      !symbolComesFromEta(pattern.receiver, checker) && !pattern.boundReceiver) return false;
  return true;
}

function recordEtaCallPattern(
  pattern: NonNullable<ReturnType<typeof getEtaCallPattern>>,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  resolveConfig: EtaInstanceConfigResolver,
  config?: EtaInstanceConfig,
): void {
  if (!pattern.methodName) return;
  const [nameArgument, dataArgument] = pattern.args;
  if (!nameArgument || !dataArgument) return;
  const finiteRecordPairs = getFiniteRecordRenderPairs(
    nameArgument,
    dataArgument,
    checker,
  );
  if (finiteRecordPairs && ETA_NAMED_TEMPLATE_RENDER_METHODS.has(pattern.methodName)) {
    for (const pair of finiteRecordPairs) {
      recordRenderCallType(pair.name, pair.data, checker, sourceFile, config);
    }
    return;
  }
  if (pattern.methodName === "renderString" || pattern.methodName === "renderStringAsync") {
    const filePath = getStaticEtaFilePath(nameArgument, sourceFile, checker, resolveConfig);
    if (filePath) recordRenderCallType(filePath, dataArgument, checker, sourceFile, config);
    return;
  }
  const names = getStaticStringValues(nameArgument, checker, (value) => resolveStaticExpression(value, checker));
  if (!names) return;
  for (const name of names) {
    if (pattern.methodName === "loadTemplate") {
      recordTemplateRegistration(name, dataArgument, checker, config);
    } else if (ETA_NAMED_TEMPLATE_RENDER_METHODS.has(pattern.methodName)) {
      recordRenderCallType(name, dataArgument, checker, sourceFile, config);
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

type ExplicitTopLevelType = "any" | "unknown";

function combineExplicitTopLevelTypes(
  values: readonly (ExplicitTopLevelType | undefined)[],
): ExplicitTopLevelType | undefined {
  if (values.includes("any")) return "any";
  return values.includes("unknown") ? "unknown" : undefined;
}

function explicitTopLevelTypeFromTypeNode(
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  seenSymbols = new Set<ts.Symbol>(),
  depth = 0,
): ExplicitTopLevelType | undefined {
  if (!node || depth > MAX_TYPE_DEPTH) return undefined;
  if (node.kind === ts.SyntaxKind.AnyKeyword || ts.isJSDocAllType(node)) return "any";
  if (node.kind === ts.SyntaxKind.UnknownKeyword || ts.isJSDocUnknownType(node)) return "unknown";
  if (ts.isParenthesizedTypeNode(node)) {
    return explicitTopLevelTypeFromTypeNode(node.type, checker, seenSymbols, depth + 1);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return combineExplicitTopLevelTypes(
      node.types.map((member) =>
        explicitTopLevelTypeFromTypeNode(member, checker, seenSymbols, depth + 1)),
    );
  }
  if (!ts.isTypeReferenceNode(node)) return undefined;

  let symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  return combineExplicitTopLevelTypes(
    (symbol.declarations ?? []).map((declaration) =>
      ts.isTypeAliasDeclaration(declaration)
        ? explicitTopLevelTypeFromTypeNode(
          declaration.type,
          checker,
          seenSymbols,
          depth + 1,
        )
        : undefined),
  );
}

function declaredTypeNode(node: ts.Node): ts.TypeNode | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isFunctionTypeNode(node) ||
    ts.isConstructorTypeNode(node) ||
    ts.isGetAccessorDeclaration(node)
  ) {
    return node.type ?? ts.getJSDocType(node);
  }
  return ts.getJSDocType(node);
}

function explicitTopLevelTypeFromExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols = new Set<ts.Symbol>(),
  depth = 0,
): ExplicitTopLevelType | undefined {
  if (depth > MAX_TYPE_DEPTH) return undefined;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return explicitTopLevelTypeFromExpression(
      expression.expression,
      checker,
      seenSymbols,
      depth + 1,
    );
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return explicitTopLevelTypeFromTypeNode(
      expression.type,
      checker,
      seenSymbols,
      depth + 1,
    ) ?? explicitTopLevelTypeFromExpression(
      expression.expression,
      checker,
      seenSymbols,
      depth + 1,
    );
  }
  if (ts.isAwaitExpression(expression)) {
    return explicitTopLevelTypeFromExpression(
      expression.expression,
      checker,
      seenSymbols,
      depth + 1,
    );
  }
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
    const declaration = checker.getResolvedSignature(expression)?.declaration;
    return declaration
      ? explicitTopLevelTypeFromTypeNode(
        declaredTypeNode(declaration),
        checker,
        seenSymbols,
        depth + 1,
      )
      : undefined;
  }

  return explicitTopLevelTypeFromSymbolExpression(expression, checker, seenSymbols, depth);
}

function explicitTopLevelTypeFromSymbolExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol>,
  depth: number,
): ExplicitTopLevelType | undefined {
  let symbolNode: ts.Node | undefined;
  if (ts.isPropertyAccessExpression(expression)) symbolNode = expression.name;
  else if (ts.isElementAccessExpression(expression)) symbolNode = expression.argumentExpression;
  else if (ts.isIdentifier(expression)) symbolNode = expression;
  let symbol = symbolNode && checker.getSymbolAtLocation(symbolNode);
  if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);

  const evidence: (ExplicitTopLevelType | undefined)[] = [];
  for (const declaration of symbol.declarations ?? []) {
    evidence.push(
      explicitTopLevelTypeFromTypeNode(
        declaredTypeNode(declaration),
        checker,
        seenSymbols,
        depth + 1,
      ),
    );
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      evidence.push(
        explicitTopLevelTypeFromExpression(
          declaration.initializer,
          checker,
          seenSymbols,
          depth + 1,
        ),
      );
    }
  }
  return combineExplicitTopLevelTypes(evidence);
}

function recordRenderCallType(
  templateName: string,
  dataArg: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  config?: EtaInstanceConfig,
): void {
  const templateKey = templateKeyForReference(templateName, sourceFile, config);
  if (currentAnalysisProject) {
    for (const key of templateKeysForWrite(templateKey)) {
      if (!templateWorkspaceProjectMap.has(key)) templateWorkspaceProjectMap.set(key, currentAnalysisProject);
    }
  }
  if (config) {
    setTemplateLanguageOptions(templateKey, config.languageOptions);
    setTemplateResolutionOptions(templateKey, {
      views: config.views,
      defaultExtension: config.defaultExtension,
    });
  }
  try {
    const type = checker.getTypeAtLocation(dataArg);
    let typeStr = typeToStructuralString(checker, type);
    if (typeStr === "any" || typeStr === "unknown") {
      const explicitType = explicitTopLevelTypeFromExpression(dataArg, checker);
      if (explicitType !== typeStr) return;
      typeStr = explicitType;
    }
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
  const project = templateWorkspaceProjectMap.get(context.sourceKey);
  if (project && !templateWorkspaceProjectMap.has(targetKey)) templateWorkspaceProjectMap.set(targetKey, project);

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
      if (selectWorkspaceProject(fileName, projects) === project) {
        configuredFiles.add(canonicalTemplatePath(fileName));
      }
    }
  }

  const inferredFiles = new Map<WorkspaceProject | undefined, string[]>();
  for (const fileName of rootNames) {
    if (configuredFiles.has(canonicalTemplatePath(fileName))) continue;
    const project = selectWorkspaceProject(fileName, projects);
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
        ...project?.options,
        allowJs: true,
        noEmit: true,
      },
    });
  }
  return analysisProjects;
}

const projectRootNameCache = new WeakMap<WorkspaceProject, {
  rootNames: string[];
  size: number;
  names: Set<string>;
}>();

function projectContainsFile(project: WorkspaceProject, fileName: string): boolean {
  let cached = projectRootNameCache.get(project);
  if (cached?.rootNames !== project.rootNames || cached?.size !== project.rootNames.length) {
    cached = { rootNames: project.rootNames, size: project.rootNames.length,
      names: new Set(project.rootNames.map(canonicalTemplatePath)) };
    projectRootNameCache.set(project, cached);
  }
  return cached.names.has(canonicalTemplatePath(fileName));
}

function selectWorkspaceProject(
  fileName: string,
  projects: readonly WorkspaceProject[],
): WorkspaceProject | undefined {
  const canonicalFileName = canonicalTemplatePath(fileName);
  let selected: WorkspaceProject | undefined;
  for (const project of projects) {
    const containsRoot = findMostSpecificContainingRoot(canonicalFileName, [project]);
    if (!containsRoot) continue;
    const containsFile = projectContainsFile(project, canonicalFileName);
    if (!selected) {
      selected = project;
      continue;
    }
    const rootLength = canonicalTemplatePath(project.root).length;
    const selectedRootLength = canonicalTemplatePath(selected.root).length;
    if (
      rootLength > selectedRootLength ||
      (rootLength === selectedRootLength &&
        containsFile !== projectContainsFile(selected, canonicalFileName) &&
        containsFile) ||
      (rootLength === selectedRootLength &&
        containsFile === projectContainsFile(selected, canonicalFileName) &&
        (project.configFileName ?? "") < (selected.configFileName ?? ""))
    ) {
      selected = project;
    }
  }
  return selected;
}

export function analyzeWorkspaceFiles(
  rootNames: string[],
  hooks: WorkspaceAnalysisHooks = {},
  projects: WorkspaceProject[] = [],
): void {
  templateWorkspaceProjectMap.clear();
  try {
    const configuredProjects = getWorkspaceAnalysisProjects(
      rootNames,
      projects,
    );
    const analyzedFiles = new Set<string>();
    for (const project of configuredProjects) {
      const ownedRootNames = project.rootNames.filter(
        (fileName) => selectWorkspaceProject(fileName, configuredProjects) === project,
      );
      if (ownedRootNames.length === 0) continue;
      const program = ts.createProgram({
        rootNames: ownedRootNames,
        options: project.options,
      });
      const checker = program.getTypeChecker();
      const rootSet = new Set(ownedRootNames.map(canonicalTemplatePath));
      for (const sourceFile of program.getSourceFiles()) {
        const fileName = canonicalTemplatePath(sourceFile.fileName);
        if (
          sourceFile.isDeclarationFile ||
          !rootSet.has(fileName) ||
          analyzedFiles.has(fileName)
        ) {
          continue;
        }
        analyzedFiles.add(fileName);
        currentAnalysisProject = project;
        try {
          analyzeOneSourceFile(sourceFile, checker, hooks);
        } finally {
          currentAnalysisProject = undefined;
        }
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
  return templateWorkspaceProjectMap.get(canonicalTemplatePath(fileName)) ??
    selectWorkspaceProject(fileName, workspaceProjects);
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
  const knownTemplateMatches = [...workspaceEtaFiles].filter(
    (fileName) =>
      path.basename(fileName, path.extname(fileName)).toLowerCase() ===
      basename.toLowerCase(),
  );
  if (knownTemplateMatches.length > 1) return undefined;
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

/** Whether a render call supplied inferred data for this template URI. */
export function hasInferredItTypeForUri(uri: string): boolean {
  try {
    return Boolean(mapKeyForTemplateUri(uri, templateDataTypeMap));
  } catch {
    return false;
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
