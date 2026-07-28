import {
  consumeTagContent,
  consumeTagOpener,
  isClosedTagContent,
  TagContentChunk,
} from "./etaScanner";
import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
} from "./etaConfig";

export const DEFAULT_IT_TYPE = "Record<string, any>";

/** Eta built-in function declarations (8 lines). */
function buildEtaBuiltins(options: EtaLanguageOptions): string {
  const outputFunctionName = options.outputFunctionName || "output";
  return [
    `declare function include(path: string, data?: Record<string, unknown>): string;`,
    `declare function includeAsync(path: string, data?: Record<string, unknown>): Promise<string>;`,
    `declare function layout(path: string, data?: Record<string, unknown>): void;`,
    `declare function block(name: string, fn?: () => void): string;`,
    `declare function blockAsync(name: string, fn?: () => Promise<void>): Promise<string>;`,
    `declare function ${outputFunctionName}(content: unknown): void;`,
    `declare function capture(fn: () => void): string;`,
    `declare function captureAsync(fn: () => Promise<void>): Promise<string>;`,
  ].join("\n");
}

/** Collapse only generated type text; user-provided JavaScript stays raw. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function getTopLevelPropertyNames(type: string): string[] {
  let body = type.trim();
  if (body.startsWith("{")) body = body.slice(1).trimStart();
  if (body.endsWith("}")) body = body.slice(0, -1).trimEnd();
  const names = new Set<string>();
  let depth = 0;
  let current = "";

  for (const ch of body) {
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      const match = /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(current);
      if (match) names.add(match[1]);
      current = "";
      continue;
    }
    current += ch;
  }

  const match = /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(current);
  if (match) names.add(match[1]);

  return [...names];
}

function buildDataDeclaration(
  itType: string,
  options: EtaLanguageOptions,
): string {
  const safeType = singleLine(itType);
  const declarations = [`declare const ${options.varName}: ${safeType};`];


  if (options.useWith) {
    for (const prop of getTopLevelPropertyNames(safeType)) {
      declarations.push(
        `declare const ${prop}: typeof ${options.varName}["${prop}"];`,
      );
    }
  }


  return declarations.join(" ");
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
  return `${header}${buildDataDeclaration(itType, options)}\n${buildEtaBuiltins(options)}\n`;
}

/** Default preamble size retained for consumers using default Eta options. */
export const PREAMBLE_LINE_COUNT = 9;

export interface VirtualDocument {
  content: string;
  preambleLineCount: number;
}

export function buildVirtualDocument(
  etaSource: string,
  itType: string = DEFAULT_IT_TYPE,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): VirtualDocument {
  const preamble = buildPreamble(itType, options);
  return {
    content:
      preamble +
      buildVirtualContentBody(etaSource, options) +
      "\nexport {};",
    preambleLineCount: preamble.split("\n").length - 1,
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

function shouldTerminateExpressionTag(
  prefix: string,
  options: EtaLanguageOptions,
): boolean {
  return prefix === options.parse.interpolate || prefix === options.parse.raw;
}

function terminateExpressionTag(js: string): string {
  for (let i = js.length - 1; i >= 0; i--) {
    if (js[i] === " ") {
      return js.slice(0, i) + ";" + js.slice(i + 1);
    }
  }
  return js;
}

function consumeVirtualTag(
  source: string,
  start: number,
  options: EtaLanguageOptions,
): TagContentChunk {
  const opener = consumeTagOpener(source, start, options);
  const terminateTag = shouldTerminateExpressionTag(opener.prefix, options);
  let js = " ".repeat(opener.padLen);
  let cursor = opener.next;

  while (cursor < source.length) {
    const content = consumeTagContent(source, cursor, options);
    js += opener.contentIsJs ? content.js : maskNonNewlineContent(content.js);
    if (isClosedTagContent(source, cursor, content.next, options)) {
      return {
        js: terminateTag ? terminateExpressionTag(js) : js,
        next: content.next,
      };
    }
    cursor = content.next;
  }

  return { js, next: cursor };
}

function buildVirtualContentBody(
  source: string,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): string {
  let out = "";
  let i = 0;
  const [open] = options.tags;
  while (i < source.length) {
    if (source.startsWith(open, i)) {
      const tag = consumeVirtualTag(source, i, options);
      out += tag.js;
      i = tag.next;
    } else {
      out += source[i] === "\n" ? "\n" : " ";
      i++;
    }
  }
  return out;
}
