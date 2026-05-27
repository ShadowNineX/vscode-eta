import * as ts from "typescript";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyNonDefaultEtaLanguageOptions,
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
  normalizeEtaLanguageOptions,
} from "./etaConfig";
import { findEtaTagRanges } from "./etaScanner";
import { DEFAULT_IT_TYPE } from "./virtualDocument";

/** Absolute fs paths of every .ts/.js file found in the workspace. */
export const workspaceTsFiles = new Set<string>();
/** Absolute fs paths of every .eta file found in the workspace. */
export const workspaceEtaFiles = new Set<string>();
/** Maps Eta template basename (no extension) -> inferred `it` type string. */
export const templateDataTypeMap = new Map<string, string>();
/** Maps Eta template basename (no extension) -> statically inferred Eta config. */
export const templateLanguageOptionsMap = new Map<string, EtaLanguageOptions>();

/** Scan the workspace root for TS/JS source files (excludes node_modules etc.). */
export function scanWorkspaceFiles(root: string): void {
  try {
    const sourceFiles = ts.sys.readDirectory(
      root,
      [".ts", ".tsx", ".js", ".jsx"],
      ["node_modules", ".git", "out", "dist", "build"],
    );
    for (const f of sourceFiles) {
      // ts.sys.readDirectory only excludes top-level directory names; nested
      // node_modules (e.g. demo/node_modules) still need this check.
      if (f.includes("node_modules")) continue;
      workspaceTsFiles.add(f);
    }
    const etaFiles = ts.sys.readDirectory(
      root,
      [".eta"],
      ["node_modules", ".git", "out", "dist", "build"],
    );
    for (const f of etaFiles) {
      if (f.includes("node_modules")) continue;
      workspaceEtaFiles.add(f);
    }
  } catch {
    // silently ignore; proceed without workspace context
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
  return ts.isStringLiteral(expr) ? expr.text : undefined;
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

function getEtaConfigFromExpression(
  expr: ts.Expression | undefined,
): EtaLanguageOptions {
  if (!expr || !ts.isObjectLiteralExpression(expr)) {
    return DEFAULT_ETA_LANGUAGE_OPTIONS;
  }
  return normalizeEtaLanguageOptions(getEtaConfigFromObjectLiteral(expr));
}

function isNewEtaExpression(expr: ts.Expression): expr is ts.NewExpression {
  return (
    ts.isNewExpression(expr) &&
    ((ts.isIdentifier(expr.expression) && expr.expression.text === "Eta") ||
      (ts.isPropertyAccessExpression(expr.expression) &&
        expr.expression.name.text === "Eta"))
  );
}

function collectEtaInstanceConfigs(
  sourceFile: ts.SourceFile,
): Map<string, EtaLanguageOptions> {
  const configs = new Map<string, EtaLanguageOptions>();

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isNewEtaExpression(node.initializer)
    ) {
      configs.set(
        node.name.text,
        getEtaConfigFromExpression(node.initializer.arguments?.[0]),
      );
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "configure" &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const instanceName = node.expression.expression.text;
      const base = configs.get(instanceName) ?? DEFAULT_ETA_LANGUAGE_OPTIONS;
      const override = getEtaConfigFromExpression(node.arguments[0]);
      configs.set(instanceName, applyNonDefaultEtaLanguageOptions(base, override));
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return configs;
}

function mergeTemplateType(key: string, typeStr: string): void {
  const existing = templateDataTypeMap.get(key);
  templateDataTypeMap.set(
    key,
    existing && existing !== typeStr ? `${existing} & ${typeStr}` : typeStr,
  );
}

function recordRenderCallType(
  templateName: string,
  dataArg: ts.Expression,
  checker: ts.TypeChecker,
  languageOptions?: EtaLanguageOptions,
): void {
  const basename = path.basename(templateName, path.extname(templateName));
  if (languageOptions) {
    templateLanguageOptionsMap.set(basename, languageOptions);
  }
  try {
    const type = checker.getTypeAtLocation(dataArg);
    const typeStr = typeToStructuralString(checker, type);
    if (typeStr === "any" || typeStr === "unknown") return;
    mergeTemplateType(basename, typeStr);
  } catch {
    // type extraction failed for this call; skip
  }
}

function withLayoutBody(typeStr: string): string {
  if (/\bbody\??:/.test(typeStr)) return typeStr;
  const trimmed = typeStr.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed.replace(/\s*}$/, "; body: string }");
  }
  return `{ body: string } & ${trimmed}`;
}

function extractLayoutTemplateNames(
  source: string,
  options: EtaLanguageOptions,
): string[] {
  const names: string[] = [];
  for (const range of findEtaTagRanges(source, options)) {
    const content = source.slice(range.contentStart, range.end);
    const matches = content.matchAll(/\blayout\s*\(\s*["']([^"']+)["']/g);
    for (const match of matches) {
      const layoutName = match[1];
      if (layoutName) names.push(layoutName);
    }
  }
  return names;
}

function templateKeyFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

export function analyzeEtaTemplateLayouts(etaFiles: string[]): void {
  for (const etaFile of etaFiles) {
    const childKey = templateKeyFromPath(etaFile);
    const childType = templateDataTypeMap.get(childKey);
    if (!childType) continue;

    const source = ts.sys.readFile(etaFile);
    if (source === undefined) continue;

    const options =
      templateLanguageOptionsMap.get(childKey) ?? DEFAULT_ETA_LANGUAGE_OPTIONS;
    for (const layoutName of extractLayoutTemplateNames(source, options)) {
      const layoutKey = templateKeyFromPath(layoutName);
      if (layoutKey === childKey) continue;
      mergeTemplateType(layoutKey, withLayoutBody(childType));
      if (!templateLanguageOptionsMap.has(layoutKey)) {
        templateLanguageOptionsMap.set(layoutKey, options);
      }
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
  const etaInstanceConfigs = collectEtaInstanceConfigs(sourceFile);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const methodName = getCalledMethodName(node.expression);
      if (methodName && ETA_NAMED_TEMPLATE_RENDER_METHODS.has(methodName)) {
        const args = node.arguments;
        if (args.length >= 2 && ts.isStringLiteral(args[0])) {
          const receiverName = getCallReceiverName(node.expression);
          recordRenderCallType(
            args[0].text,
            args[1],
            checker,
            receiverName ? etaInstanceConfigs.get(receiverName) : undefined,
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
): void {
  try {
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
      analyzeOneSourceFile(sf, checker, hooks);
    }
    analyzeEtaTemplateLayouts([...workspaceEtaFiles]);
  } catch (e) {
    hooks.onFailure?.(e);
  }
}

/** Return the `it` type inferred for this template URI, or the default. */
export function getItTypeForUri(uri: string): string {
  try {
    const fsPath = fileURLToPath(uri);
    const basename = path.basename(fsPath, path.extname(fsPath));
    return templateDataTypeMap.get(basename) ?? DEFAULT_IT_TYPE;
  } catch {
    return DEFAULT_IT_TYPE;
  }
}

export function getEtaLanguageOptionsForUri(
  uri: string,
): EtaLanguageOptions | undefined {
  try {
    const fsPath = fileURLToPath(uri);
    const basename = path.basename(fsPath, path.extname(fsPath));
    return templateLanguageOptionsMap.get(basename);
  } catch {
    return undefined;
  }
}
