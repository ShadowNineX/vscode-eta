import * as ts from "typescript";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_IT_TYPE } from "./virtualDocument";

/** Absolute fs paths of every .ts/.js file found in the workspace. */
export const workspaceTsFiles = new Set<string>();
/** Maps Eta template basename (no extension) -> inferred `it` type string. */
export const templateDataTypeMap = new Map<string, string>();

/** Scan the workspace root for TS/JS source files (excludes node_modules etc.). */
export function scanWorkspaceFiles(root: string): void {
  try {
    const files = ts.sys.readDirectory(
      root,
      [".ts", ".tsx", ".js", ".jsx"],
      ["node_modules", ".git", "out", "dist", "build"],
    );
    for (const f of files) {
      // ts.sys.readDirectory only excludes top-level directory names; nested
      // node_modules (e.g. demo/node_modules) still need this check.
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
    return el ? `${typeToStructuralString(checker, el, depth + 1)}[]` : "any[]";
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
 * calls and record the inferred structural type of `data`.
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
