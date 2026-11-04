import ts from "typescript";
import {
  createTagContentScanner,
  consumeTagOpener,
  TagContentChunk,
  TagContentScanner,
} from "./etaScanner";
import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
} from "./etaConfig";

export const DEFAULT_IT_TYPE = "Record<string, unknown>";

/** Eta built-in function declarations (8 lines). */
function buildEtaBuiltins(options: EtaLanguageOptions, withBindings: string): string {
  const outputFunctionName = options.outputFunctionName || "output";
  return [
    "const include = undefined as unknown as (path: string, data?: Record<string, unknown>) => string;",
    "const includeAsync = undefined as unknown as (path: string, data?: Record<string, unknown>) => Promise<string>;",
    "const layout = undefined as unknown as (path: string, data?: Record<string, unknown>) => void;" + withBindings,
    "const block = undefined as unknown as (name: string, fn?: () => void) => string;",
    "const blockAsync = undefined as unknown as (name: string, fn?: () => Promise<void>) => Promise<string>;",
    `const ${outputFunctionName} = undefined as unknown as (content: unknown) => void;`,
    "const capture = undefined as unknown as (fn: () => void) => string;",
    "const captureAsync = undefined as unknown as (fn: () => Promise<void>) => Promise<string>;",
  ].join("\n");
}

/** Collapse only generated type text; user-provided JavaScript stays raw. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function getTopLevelPropertyNames(type: string): string[] {
  const source = ts.createSourceFile(
    "eta-data-type.ts", `type Data = ${type};`, ts.ScriptTarget.Latest, false,
  );
  const names = new Set<string>();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
  function collect(node: ts.TypeNode): void {
    if (ts.isParenthesizedTypeNode(node)) {
      collect(node.type);
    } else if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      node.types.forEach(collect);
    } else if (ts.isTypeLiteralNode(node)) {
      for (const member of node.members) {
        if (!member.name || (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))) {
          continue;
        }
        const name = member.name.text;
        scanner.setText(name);
        const token = scanner.scan();
        const identifier = scanner.getTokenText() === name;
        // Property keys can be reserved words or contain punctuation; only
        // names that are legal bindings can be exposed as bare variables.
        if (
          identifier &&
          (token === ts.SyntaxKind.Identifier || token > ts.SyntaxKind.LastFutureReservedWord) &&
          token !== ts.SyntaxKind.AwaitKeyword && token !== ts.SyntaxKind.LetKeyword &&
          name !== "eval" && name !== "arguments" &&
          scanner.scan() === ts.SyntaxKind.EndOfFileToken
        ) {
          names.add(name);
        }
      }
    }
  }
  const declaration = source.statements[0];
  if (declaration && ts.isTypeAliasDeclaration(declaration)) collect(declaration.type);
  return [...names];
}

function buildTemplateFunctionStart(
  itType: string,
  options: EtaLanguageOptions,
): string {
  const safeType = singleLine(itType);
  const asyncPrefix = options.async ? "async " : "";
  const returnType = options.async ? "Promise<void>" : "void";
  return (
    "type __EtaOverride<Base, Override> = Base extends unknown ? Omit<Base, keyof Override> & Override : never; " +
    (options.useWith
      ? "type __EtaWith<T> = { [K in T extends unknown ? keyof T : never]: T extends unknown ? K extends keyof T ? T[K] : undefined : never }; "
      : "") +
    `${asyncPrefix}function __etaTemplate(${options.varName}: ${safeType}, ` +
    "options: Readonly<{ filepath?: string; async?: boolean }> & " +
    `Record<string, unknown>): ${returnType} {`
  );
}

function buildWithBindings(itType: string, options: EtaLanguageOptions): string {
  if (!options.useWith) return "";
  const names = getTopLevelPropertyNames(singleLine(itType));
  let alias = "__etaWithData";
  while (names.includes(alias) || alias === options.varName || options.functionHeader.includes(alias)) alias += "_";
  // Eta's with scope shadows parameters and include/layout, while its
  // output/capture/block helpers and template-local declarations live inside it.
  return ` const ${alias} = ${options.varName}; { const { ${names.join(", ")} } = ${alias} as __EtaWith<typeof ${alias}>; {`;
}

export function buildPreamble(
  itType: string,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): string {
  const normalizedHeader = options.functionHeader.replaceAll("\r\n", "\n");
  let header = "";
  if (normalizedHeader) {
    header = normalizedHeader.endsWith("\n")
      ? normalizedHeader
      : `${normalizedHeader}\n`;
  }
  return `${buildTemplateFunctionStart(itType, options)}\n${header}${buildEtaBuiltins(options, buildWithBindings(itType, options))}\n`;
}

/** Default preamble size retained for consumers using default Eta options. */
export const PREAMBLE_LINE_COUNT = 9;

export interface VirtualDocument {
  content: string;
  preambleLineCount: number;
  bodyOffset: number;
}

export function buildVirtualDocument(
  etaSource: string,
  itType: string = DEFAULT_IT_TYPE,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): VirtualDocument {
  const preamble = buildPreamble(itType, options);
  return {
    content:
      preamble + buildVirtualContentBody(etaSource, options) +
      (options.useWith ? "\n}\n}\n" : "\n") + "}\nexport {};\n",
    preambleLineCount: preamble.split("\n").length - 1,
    bodyOffset: preamble.length,
  };
}
export function buildRuntimeVirtualDocument(
  etaSource: string,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): VirtualDocument {
  const normalizedHeader = options.functionHeader.replaceAll("\r\n", "\n");
  const header =
    normalizedHeader && !normalizedHeader.endsWith("\n")
      ? `${normalizedHeader}\n`
      : normalizedHeader;
  const preamble =
    `${options.async ? "async " : ""}function __etaTemplate(${options.varName}, options) {\n` +
    "\n".repeat(PREAMBLE_LINE_COUNT - 1) +
    header;
  return {
    content: preamble + buildVirtualContentBody(etaSource, options) + "\n}\n",
    preambleLineCount: preamble.split("\n").length - 1,
    bodyOffset: preamble.length,
  };
}

/**
 * Build a virtual TypeScript file from Eta source. Generated preamble lines
 * precede a length-preserving template body; raw functionHeader lines make the
 * body offset dynamic.
 */
export function buildVirtualContent(
  etaSource: string,
  itType: string = DEFAULT_IT_TYPE,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): string {
  return buildVirtualDocument(etaSource, itType, options).content;
}

export function buildVirtualLine(
  line: string,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): string {
  return buildVirtualContentBody(line, options);
}

function maskNonNewlineContent(value: string): string {
  return value.replace(/[^\n]/g, " ");
}

function terminateJavaScriptTag(js: string): string {
  for (let i = js.length - 1; i >= 0; i--) {
    if (js[i] === " ") {
      return js.slice(0, i) + ";" + js.slice(i + 1);
    }
  }
  return js;
}

function maskTrailingLineComment(js: string): string {
  if (!js.includes("//")) return js;
  // Parse only tags containing a possible line comment. TypeScript distinguishes
  // comments from regexes and template/string literals, even in partial code.
  const source = ts.createSourceFile("eta-tag.js", js, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const ranges = new Map<number, ts.CommentRange>();
  function visit(node: ts.Node): void {
    for (const range of [
      ...(ts.getLeadingCommentRanges(js, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(js, node.end) ?? []),
    ]) {
      if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia && range.end === js.length) {
        ranges.set(range.pos, range);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const characters = js.split("");
  for (const { pos, end } of ranges.values()) {
    for (let i = pos; i < end; i++) characters[i] = " ";
  }
  return characters.join("");
}

function consumeVirtualTag(
  source: string,
  start: number,
  options: EtaLanguageOptions,
  consumeContent: TagContentScanner,
): TagContentChunk {
  const opener = consumeTagOpener(source, start, options);
  let js = " ".repeat(opener.padLen);
  let cursor = opener.next;

  while (cursor < source.length) {
    const content = consumeContent(cursor);
    js += opener.contentIsJs ? content.js : maskNonNewlineContent(content.js);
    if (content.closed) {
      return {
        js: opener.contentIsJs ? terminateJavaScriptTag(maskTrailingLineComment(js)) : js,
        next: content.next,
      };
    }
    cursor = content.next;
  }

  return { js, next: cursor };
}

export function buildVirtualContentBody(
  source: string,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): string {
  let out = "";
  let i = 0;
  const [open] = options.tags;
  const consumeContent = createTagContentScanner(source, options);
  while (i < source.length) {
    if (source.startsWith(open, i)) {
      const tag = consumeVirtualTag(source, i, options, consumeContent);
      out += tag.js;
      i = tag.next;
    } else {
      out += source[i] === "\n" ? "\n" : " ";
      i++;
    }
  }
  return out;
}
