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
    ts.isTypeAssertionExpression(expression)
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

  if (access.root === options.varName || access.root === "it") {
    return access.path;
  }
  if (options.useWith) {
    return [access.root, ...access.path];
  }
  return undefined;
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
