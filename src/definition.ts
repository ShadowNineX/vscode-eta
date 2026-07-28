import ts from "typescript";
import type { EtaLanguageOptions } from "./etaConfig";

interface DataAccess {
  root: string;
  path: string[];
}

function getDataAccess(expression: ts.Expression): DataAccess | undefined {
  if (ts.isIdentifier(expression)) {
    return { root: expression.text, path: [] };
  }

  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return getDataAccess(expression.expression);
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const base = getDataAccess(expression.expression);
    return base
      ? { root: base.root, path: [...base.path, expression.name.text] }
      : undefined;
  }

  if (ts.isElementAccessExpression(expression)) {
    const base = getDataAccess(expression.expression);
    if (!base || !expression.argumentExpression) return undefined;
    if (
      ts.isStringLiteral(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)
    ) {
      return {
        root: base.root,
        path: [...base.path, expression.argumentExpression.text],
      };
    }
    return ts.isNumericLiteral(expression.argumentExpression)
      ? base
      : undefined;
  }

  return undefined;
}

function resolveDataAccessPath(
  access: DataAccess,
  aliases: Map<string, string[]>,
  options: EtaLanguageOptions,
): string[] | undefined {
  if (access.root === options.varName) return access.path;
  const aliasPath = aliases.get(access.root);
  if (aliasPath) return [...aliasPath, ...access.path];
  return options.useWith ? [access.root, ...access.path] : undefined;
}

function getBindingPropertyName(
  element: ts.BindingElement,
): string | undefined {
  const propertyName = element.propertyName;
  if (propertyName === undefined) {
    if (ts.isIdentifier(element.name)) return element.name.text;
    return undefined;
  }

  if (
    ts.isIdentifier(propertyName) ||
    ts.isStringLiteral(propertyName) ||
    ts.isNumericLiteral(propertyName)
  ) {
    return propertyName.text;
  }
  return undefined;
}

function bindObjectDataAliases(
  name: ts.ObjectBindingPattern,
  basePath: string[],
  aliases: Map<string, string[]>,
): void {
  for (const element of name.elements) {
    if (element.dotDotDotToken) continue;
    const propertyName = getBindingPropertyName(element);
    if (propertyName === undefined) continue;
    bindDataAlias(element.name, [...basePath, propertyName], aliases);
  }
}

function bindArrayDataAliases(
  name: ts.ArrayBindingPattern,
  basePath: string[],
  aliases: Map<string, string[]>,
): void {
  for (const element of name.elements) {
    if (!ts.isBindingElement(element) || element.dotDotDotToken) continue;
    bindDataAlias(element.name, basePath, aliases);
  }
}

function bindDataAlias(
  name: ts.BindingName,
  basePath: string[],
  aliases: Map<string, string[]>,
): void {
  if (ts.isIdentifier(name)) {
    aliases.set(name.text, basePath);
    return;
  }

  if (ts.isObjectBindingPattern(name)) {
    bindObjectDataAliases(name, basePath, aliases);
    return;
  }

  bindArrayDataAliases(name, basePath, aliases);
}

function getCallbackDataPath(
  parameter: ts.ParameterDeclaration,
  aliases: Map<string, string[]>,
  options: EtaLanguageOptions,
): string[] | undefined {
  const callback = parameter.parent;
  if (
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    callback.parameters[0] !== parameter ||
    !ts.isCallExpression(callback.parent) ||
    !ts.isPropertyAccessExpression(callback.parent.expression) ||
    callback.parent.arguments[0] !== callback
  ) {
    return undefined;
  }
  const method = callback.parent.expression.name.text;
  if (!["every", "filter", "find", "flatMap", "forEach", "map", "some"].includes(method)) {
    return undefined;
  }
  const access = getDataAccess(callback.parent.expression.expression);
  return access
    ? resolveDataAccessPath(access, aliases, options)
    : undefined;
}

function collectDataAliases(
  sourceFile: ts.SourceFile,
  options: EtaLanguageOptions,
): Map<string, string[]> {
  const aliases = new Map<string, string[]>();

  function pathForExpression(
    expression: ts.Expression,
  ): string[] | undefined {
    const access = getDataAccess(expression);
    return access
      ? resolveDataAccessPath(access, aliases, options)
      : undefined;
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      let expression = node.initializer;
      const declarationList = node.parent;
      const loop = declarationList.parent;
      if (
        !expression &&
        ts.isVariableDeclarationList(declarationList) &&
        ts.isForOfStatement(loop)
      ) {
        expression = loop.expression;
      }
      const dataPath = expression && pathForExpression(expression);
      if (dataPath) bindDataAlias(node.name, dataPath, aliases);
    } else if (ts.isParameter(node)) {
      const dataPath = getCallbackDataPath(node, aliases, options);
      if (dataPath) bindDataAlias(node.name, dataPath, aliases);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return aliases;
}

/**
 * Resolve the inferred render-data path under an Eta cursor. Numeric array
 * indexes do not add a path segment because definitions belong to element
 * properties rather than to individual indexes.
 */
export function getEtaDataPathAtPosition(
  virtualContent: string,
  virtualOffset: number,
  options: EtaLanguageOptions,
): string[] | undefined {
  const sourceFile = ts.createSourceFile(
    "virtual.eta.ts",
    virtualContent,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let nodeAtPosition: ts.Node | undefined;

  function visit(node: ts.Node): void {
    if (
      virtualOffset < node.getStart(sourceFile) ||
      virtualOffset >= node.getEnd()
    ) {
      return;
    }
    nodeAtPosition = node;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (!nodeAtPosition) return undefined;

  let expression: ts.Expression | undefined;
  if (ts.isIdentifier(nodeAtPosition)) {
    expression =
      ts.isPropertyAccessExpression(nodeAtPosition.parent) &&
      nodeAtPosition.parent.name === nodeAtPosition
        ? nodeAtPosition.parent
        : nodeAtPosition;
  } else if (
    (ts.isStringLiteral(nodeAtPosition) ||
      ts.isNoSubstitutionTemplateLiteral(nodeAtPosition) ||
      ts.isNumericLiteral(nodeAtPosition)) &&
    ts.isElementAccessExpression(nodeAtPosition.parent) &&
    nodeAtPosition.parent.argumentExpression === nodeAtPosition
  ) {
    expression = nodeAtPosition.parent;
  }

  if (!expression) return undefined;
  const access = getDataAccess(expression);
  if (!access) return undefined;
  return resolveDataAccessPath(
    access,
    collectDataAliases(sourceFile, options),
    options,
  );
}

export function offsetToPosition(
  content: string,
  offset: number,
): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  const limit = Math.min(Math.max(offset, 0), content.length);
  for (let index = 0; index < limit; index++) {
    if (content[index] === "\n") {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, character: limit - lineStart };
}
