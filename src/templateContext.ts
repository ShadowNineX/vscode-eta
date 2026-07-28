import * as path from "node:path";
import { EtaLanguageOptions } from "./etaConfig";
import { findEtaTagRanges } from "./etaScanner";

export interface StringCallContext {
  functionName: string;
  value: string;
  valueStart: number;
  valueEnd: number;
}

const PATH_HELPERS = new Set(["include", "includeAsync", "layout"]);
const BLOCK_HELPERS = new Set(["block", "blockAsync"]);

function findStringCallContexts(
  source: string,
  options: EtaLanguageOptions,
  helperNames: Set<string>,
): StringCallContext[] {
  const contexts: StringCallContext[] = [];
  for (const range of findEtaTagRanges(source, options)) {
    const content = source.slice(range.contentStart, range.end);
    const pattern = /\b([A-Za-z_$][\w$]*)\s*\(\s*(["'`])([^"'`]*)\2/g;
    for (const match of content.matchAll(pattern)) {
      const functionName = match[1];
      if (!helperNames.has(functionName)) continue;
      const whole = match[0];
      const value = match[3];
      const valueOffset = whole.indexOf(value, whole.indexOf(match[2]) + 1);
      const valueStart = range.contentStart + (match.index ?? 0) + valueOffset;
      contexts.push({
        functionName,
        value,
        valueStart,
        valueEnd: valueStart + value.length,
      });
    }
  }
  return contexts;
}

export function getTemplatePathContextAtOffset(
  source: string,
  offset: number,
  options: EtaLanguageOptions,
): StringCallContext | undefined {
  const completed = findStringCallContexts(source, options, PATH_HELPERS).find(
    (context) => offset >= context.valueStart && offset <= context.valueEnd,
  );
  if (completed) return completed;

  const range = findEtaTagRanges(source, options).find(
    (tag) => offset >= tag.contentStart && offset <= tag.end,
  );
  if (!range) return undefined;
  const prefix = source.slice(range.contentStart, offset);
  const match =
    /\b(include|includeAsync|layout)\s*\(\s*(["'`])([^"'`]*)$/.exec(prefix);
  if (!match) return undefined;
  const value = match[3];
  return {
    functionName: match[1],
    value,
    valueStart: offset - value.length,
    valueEnd: offset,
  };
}

export interface BlockCallContext extends StringCallContext {
  declaration: boolean;
}

export function getBlockCallContexts(
  source: string,
  options: EtaLanguageOptions,
): BlockCallContext[] {
  return findStringCallContexts(source, options, BLOCK_HELPERS).map((context) => {
    const afterName = source.slice(context.valueEnd + 1, context.valueEnd + 200);
    return {
      ...context,
      declaration: /^\s*,/.test(afterName),
    };
  });
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
  return [...new Set(values)].sort(compareStrings);
}
