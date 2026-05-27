import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
  getTagPrefixCandidates,
  isJavaScriptTagPrefix,
} from "./etaConfig";

type Quote = '"' | "'" | "`";

interface TagContentState {
  quote: Quote | undefined;
  lineComment: boolean;
  blockComment: boolean;
}

export interface TagContentChunk {
  js: string;
  next: number;
}

export interface EtaTagRange {
  start: number;
  contentStart: number;
  end: number;
  closed: boolean;
  empty: boolean;
}

/** Consume the <% opener and its modifier chars; returns chars consumed and new index. */
export function consumeTagOpener(
  line: string,
  start: number,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): { padLen: number; next: number; prefix: string; contentIsJs: boolean } {
  const [open] = options.tags;
  let i = start + open.length;
  if (i < line.length && (line[i] === "-" || line[i] === "_")) {
    i++;
  }
  let prefix = i;
  while (prefix < line.length && /[ \t]/.test(line[prefix])) {
    prefix++;
  }

  for (const candidate of getTagPrefixCandidates(options)) {
    if (line.startsWith(candidate, prefix)) {
      return {
        padLen: prefix + candidate.length - start,
        next: prefix + candidate.length,
        prefix: candidate,
        contentIsJs: isJavaScriptTagPrefix(candidate, options),
      };
    }
  }

  return {
    padLen: i - start,
    next: i,
    prefix: options.parse.exec,
    contentIsJs: options.parse.exec === "",
  };
}

function consumeLineCommentChar(
  line: string,
  index: number,
  state: TagContentState,
): TagContentChunk {
  state.lineComment = line[index] !== "\n";
  return { js: line[index], next: index + 1 };
}

function consumeBlockCommentChar(
  line: string,
  index: number,
  state: TagContentState,
): TagContentChunk {
  if (line[index] === "*" && line[index + 1] === "/") {
    state.blockComment = false;
    return { js: "*/", next: index + 2 };
  }
  return { js: line[index], next: index + 1 };
}

function consumeQuotedChar(
  line: string,
  index: number,
  state: TagContentState,
): TagContentChunk {
  const ch = line[index];
  if (ch === "\\") {
    const next = Math.min(index + 2, line.length);
    return { js: line.slice(index, next), next };
  }
  if (ch === state.quote) state.quote = undefined;
  return { js: ch, next: index + 1 };
}

function consumeActiveTagState(
  line: string,
  index: number,
  state: TagContentState,
): TagContentChunk | undefined {
  if (state.lineComment) return consumeLineCommentChar(line, index, state);
  if (state.blockComment) return consumeBlockCommentChar(line, index, state);
  if (state.quote) return consumeQuotedChar(line, index, state);
  return undefined;
}

function consumeStateStart(
  line: string,
  index: number,
  state: TagContentState,
): TagContentChunk | undefined {
  const pair = line.slice(index, index + 2);
  if (pair === "//") {
    state.lineComment = true;
    return { js: pair, next: index + 2 };
  }
  if (pair === "/*") {
    state.blockComment = true;
    return { js: pair, next: index + 2 };
  }
  const ch = line[index];
  if (ch === '"' || ch === "'" || ch === "`") {
    state.quote = ch;
    return { js: ch, next: index + 1 };
  }
  return undefined;
}

function consumeTagCloser(
  line: string,
  index: number,
  options: EtaLanguageOptions,
): TagContentChunk | undefined {
  const close = options.tags[1];
  if (line.startsWith(close, index)) {
    return { js: " ".repeat(close.length), next: index + close.length };
  }
  if (
    (line[index] === "-" || line[index] === "_") &&
    line.startsWith(close, index + 1)
  ) {
    return { js: " ".repeat(close.length + 1), next: index + close.length + 1 };
  }
  return undefined;
}

/** Consume JS content until closing %> (or -%> / _%>); returns js text and new index. */
export function consumeTagContent(
  line: string,
  start: number,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): TagContentChunk {
  const state: TagContentState = {
    quote: undefined,
    lineComment: false,
    blockComment: false,
  };
  let js = "";
  let i = start;

  while (i < line.length) {
    const chunk =
      consumeActiveTagState(line, i, state) ??
      consumeStateStart(line, i, state);
    if (chunk) {
      js += chunk.js;
      i = chunk.next;
      continue;
    }
    const closer = consumeTagCloser(line, i, options);
    if (closer) return { js: js + closer.js, next: closer.next };
    js += line[i];
    i++;
  }
  return { js, next: i };
}

export function isClosedTagContent(
  source: string,
  from: number,
  to: number,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): boolean {
  const close = options.tags[1];
  return (
    to > from &&
    (source.slice(to - close.length, to) === close ||
      (to > close.length &&
        (source[to - close.length - 1] === "-" ||
          source[to - close.length - 1] === "_") &&
        source.slice(to - close.length, to) === close))
  );
}

function consumeEtaTagRange(
  source: string,
  start: number,
  options: EtaLanguageOptions,
): EtaTagRange {
  const opener = consumeTagOpener(source, start, options);
  let cursor = opener.next;
  let content = "";

  while (cursor < source.length) {
    const consumed = consumeTagContent(source, cursor, options);
    content += consumed.js;
    cursor = consumed.next;
    if (isClosedTagContent(source, opener.next, cursor, options)) {
      return {
        start,
        contentStart: opener.next,
        end: cursor,
        closed: true,
        empty: content.trim().length === 0,
      };
    }
  }

  return {
    start,
    contentStart: opener.next,
    end: cursor,
    closed: false,
    empty: content.trim().length === 0,
  };
}

export function findEtaTagRanges(
  source: string,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): EtaTagRange[] {
  const ranges: EtaTagRange[] = [];
  let i = 0;
  const [open] = options.tags;

  while (i < source.length) {
    if (!source.startsWith(open, i)) {
      i++;
      continue;
    }

    const range = consumeEtaTagRange(source, i, options);
    ranges.push(range);
    i = Math.max(range.end, range.start + open.length);
  }

  return ranges;
}
