import * as path from "node:path";
import ts from "typescript";
import { EtaLanguageOptions } from "./etaConfig";
import { buildVirtualContentBody } from "./virtualDocument";

export interface StringCallContext {
  functionName: string;
  value: string;
  valueStart: number;
  valueEnd: number;
}

interface ParsedStringCallContext extends StringCallContext {
  argumentCount: number;
}

const PATH_HELPERS = new Set(["include", "includeAsync", "layout"]);
const BLOCK_HELPERS = new Set(["block", "blockAsync"]);

function findStringCallContexts(
  source: string,
  options: EtaLanguageOptions,
  helperNames: Set<string>,
): ParsedStringCallContext[] {
  const virtualSource = buildVirtualContentBody(source, options);
  const sourceFile = ts.createSourceFile(
    "eta-template.ts",
    virtualSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const contexts: ParsedStringCallContext[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      helperNames.has(node.expression.text)
    ) {
      const argument = node.arguments[0];
      if (
        argument &&
        (ts.isStringLiteral(argument) ||
          ts.isNoSubstitutionTemplateLiteral(argument))
      ) {
        const literalStart = argument.getStart(sourceFile);
        const literalEnd = argument.getEnd();
        const quote = virtualSource[literalStart];
        const hasClosingQuote = virtualSource[literalEnd - 1] === quote;
        const valueStart = literalStart + 1;
        const valueEnd = hasClosingQuote ? literalEnd - 1 : literalEnd;
        contexts.push({
          functionName: node.expression.text,
          value: source.slice(valueStart, valueEnd),
          valueStart,
          valueEnd,
          argumentCount: node.arguments.length,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return contexts.sort(
    (left, right) => left.valueStart - right.valueStart,
  );
}

export function getTemplatePathContextAtOffset(
  source: string,
  offset: number,
  options: EtaLanguageOptions,
): StringCallContext | undefined {
  return findStringCallContexts(source, options, PATH_HELPERS).find(
    (context) => offset >= context.valueStart && offset <= context.valueEnd,
  );
}

export interface BlockCallContext extends StringCallContext {
  declaration: boolean;
}

export function getBlockCallContexts(
  source: string,
  options: EtaLanguageOptions,
): BlockCallContext[] {
  return findStringCallContexts(source, options, BLOCK_HELPERS).map(
    ({ argumentCount, ...context }) => ({
      ...context,
      declaration: argumentCount > 1,
    }),
  );
}

export function getBlockCallContextAtOffset(
  source: string,
  offset: number,
  options: EtaLanguageOptions,
): BlockCallContext | undefined {
  return getBlockCallContexts(source, options).find(
    (context) => offset >= context.valueStart && offset <= context.valueEnd,
  );
}

function normalizePathSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function getTemplatePathCompletions(
  currentFile: string,
  partial: string,
  templateFiles: Iterable<string>,
  views?: string,
  registeredTemplates: Iterable<string> = [],
): string[] {
  const currentDirectory = path.dirname(currentFile);
  const baseDirectory =
    !partial.startsWith(".") && views ? views : currentDirectory;
  const normalizedPartial = normalizePathSeparators(partial);
  const values = [...templateFiles]
    .filter((fileName) => path.resolve(fileName) !== path.resolve(currentFile))
    .map((fileName) => {
      let relative = normalizePathSeparators(
        path.relative(baseDirectory, fileName),
      ).replace(/\.eta$/i, "");
      if (normalizedPartial.startsWith(".") && !relative.startsWith(".")) {
        relative = `./${relative}`;
      }
      return relative;
    })
    .filter((value) => value.startsWith(normalizedPartial));
  return [
    ...new Set([
      ...values,
      ...[...registeredTemplates].filter((value) =>
        value.startsWith(normalizedPartial),
      ),
    ]),
  ].sort(compareStrings);
}
