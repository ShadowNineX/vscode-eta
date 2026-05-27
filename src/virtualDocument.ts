import {
  consumeTagContent,
  consumeTagOpener,
  isClosedTagContent,
  TagContentChunk,
} from "./etaScanner";

export const DEFAULT_IT_TYPE = "Record<string, any>";

/** Eta built-in function declarations (8 lines, each ending with \n). */
const ETA_BUILTINS = [
  `declare function include(path: string, data?: Record<string, any>): string;`,
  `declare function includeAsync(path: string, data?: Record<string, any>): Promise<string>;`,
  `declare function layout(path: string, data?: Record<string, any>): void;`,
  `declare function block(name: string, fn?: () => void): string;`,
  `declare function blockAsync(name: string, fn?: () => Promise<void>): Promise<string>;`,
  `declare function output(content: string): void;`,
  `declare function capture(fn: () => void): string;`,
  `declare function captureAsync(fn: () => Promise<void>): Promise<string>;`,
].join("\n");

/**
 * Build the 9-line preamble injected at the top of every virtual TS file.
 * The `it` declaration is always a single line so PREAMBLE_LINE_COUNT is fixed.
 */
export function buildPreamble(itType: string): string {
  const safe = itType.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return `declare const it: ${safe};\n${ETA_BUILTINS}\n`;
}

/** Always 9 lines: 1 (`it`) + 8 (built-ins). Verified by test. */
export const PREAMBLE_LINE_COUNT = 9;

/**
 * Build a virtual TypeScript file from Eta source.
 * Prepends a 9-line preamble (with the correct `it` type), then replaces
 * non-tag characters with spaces so offsets inside tags are preserved.
 */
export function buildVirtualContent(
  etaSource: string,
  itType: string = DEFAULT_IT_TYPE,
): string {
  return (
    buildPreamble(itType) +
    buildVirtualContentBody(etaSource) +
    // Append a module marker so TypeScript treats this as a module (not a
    // global script). Without it every virtual file shares global scope.
    "\nexport {};"
  );
}

export function buildVirtualLine(line: string): string {
  return buildVirtualContentBody(line);
}

function consumeVirtualTag(source: string, start: number): TagContentChunk {
  const opener = consumeTagOpener(source, start);
  let js = " ".repeat(opener.padLen);
  let cursor = opener.next;

  while (cursor < source.length) {
    const content = consumeTagContent(source, cursor);
    js += content.js;
    if (isClosedTagContent(source, cursor, content.next)) {
      return { js, next: content.next };
    }
    cursor = content.next;
  }

  return { js, next: cursor };
}

function buildVirtualContentBody(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "<" && source[i + 1] === "%") {
      const tag = consumeVirtualTag(source, i);
      out += tag.js;
      i = tag.next;
    } else {
      out += source[i] === "\n" ? "\n" : " ";
      i++;
    }
  }
  return out;
}
