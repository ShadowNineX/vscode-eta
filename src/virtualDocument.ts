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
    "const include = undefined as unknown as (path: string, data?: Record<string, unknown>) => string;",
    "const includeAsync = undefined as unknown as (path: string, data?: Record<string, unknown>) => Promise<string>;",
    "const layout = undefined as unknown as (path: string, data?: Record<string, unknown>) => void;",
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

function buildTemplateFunctionStart(
  itType: string,
  options: EtaLanguageOptions,
): string {
  const safeType = singleLine(itType);
  const asyncPrefix = options.async ? "async " : "";
  const returnType = options.async ? "Promise<void>" : "void";
  const withBindings = options.useWith
    ? ` const { ${getTopLevelPropertyNames(safeType).join(", ")} } = ${options.varName};`
    : "";
  return (
    "type __EtaOverride<Base, Override> = Base extends unknown ? Omit<Base, keyof Override> & Override : never; " +
    `${asyncPrefix}function __etaTemplate(${options.varName}: ${safeType}, ` +
    "options: Readonly<{ filepath?: string; async?: boolean }> & " +
    `Record<string, unknown>): ${returnType} {${withBindings}`
  );
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
  return `${buildTemplateFunctionStart(itType, options)}\n${buildEtaBuiltins(options)}\n${header}`;
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
      preamble + buildVirtualContentBody(etaSource, options) + "\n}\nexport {};\n",
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

function shouldTerminateJavaScriptTag(
  prefix: string,
  options: EtaLanguageOptions,
): boolean {
  return (
    prefix === options.parse.exec ||
    prefix === options.parse.interpolate ||
    prefix === options.parse.raw
  );
}

function terminateJavaScriptTag(js: string): string {
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
  const terminateTag = shouldTerminateJavaScriptTag(opener.prefix, options);
  let js = " ".repeat(opener.padLen);
  let cursor = opener.next;

  while (cursor < source.length) {
    const content = consumeTagContent(source, cursor, options);
    js += opener.contentIsJs ? content.js : maskNonNewlineContent(content.js);
    if (isClosedTagContent(source, cursor, content.next, options)) {
      return {
        js: terminateTag ? terminateJavaScriptTag(js) : js,
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
