import {
  DEFAULT_ETA_LANGUAGE_OPTIONS,
  EtaLanguageOptions,
  getTagPrefixCandidates,
  isJavaScriptTagPrefix,
} from "./etaConfig";

type Quote = '"' | "'" | "`";

interface TagContentState {
  quote: Quote | undefined;
  blockComment: boolean;
}

function templateContentEnd(
  source: string,
  index: number,
  ends: Uint32Array,
  interpolationEnd: number,
): number {
  const ch = source[index];
  if (ch === "`") return index + 1;
  if (ch === "\\") return ends[index + 2];
  if (ch === "$" && source[index + 1] === "{") return interpolationEnd;
  return ends[index + 1];
}

// Match Eta's bounded template-literal grammar, including its treatment of
// quotes/comments as ordinary interpolation content and of extra opening braces
// inside the innermost brace group. Zero means no closing backtick is reachable.
// Working backwards lets each state reuse the result for its remaining suffix,
// so repeated incomplete literals cannot repeatedly scan the rest of the file.
function buildTemplateLiteralEnds(source: string): Uint32Array {
  const ends = new Uint32Array(source.length + 2);
  let interpolationEnd = 0;
  let nestedBraceEnd = 0;
  let innerBraceEnd = 0;
  let interpolationAfterNext = 0;

  for (let i = source.length - 1; i >= 0; i--) {
    ends[i] = templateContentEnd(source, i, ends, interpolationAfterNext);
    interpolationAfterNext = interpolationEnd;
    if (source[i] === "}") {
      innerBraceEnd = nestedBraceEnd;
      nestedBraceEnd = interpolationEnd;
      interpolationEnd = ends[i + 1];
    } else if (source[i] === "{") {
      interpolationEnd = nestedBraceEnd;
      nestedBraceEnd = innerBraceEnd;
    }
  }
  return ends;
}

export type UnclosedTagState = "string" | "block-comment";

export interface TagContentChunk {
  js: string;
  next: number;
  closed?: boolean;
  unclosedState?: UnclosedTagState;
}

export type TagContentScanner = (start: number) => TagContentChunk;

/** Share lazy template-literal indexing across all tags in one source. */
export function createTagContentScanner(
  source: string,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): TagContentScanner {
  let templateEnds: Uint32Array | undefined;
  const templateEnd = (index: number): number => {
    templateEnds ??= buildTemplateLiteralEnds(source);
    return templateEnds[index + 1];
  };
  return (start) => consumeTagContentWithMatcher(source, start, options, templateEnd);
}

export interface EtaTagRange {
  start: number;
  contentStart: number;
  end: number;
  closed: boolean;
  empty: boolean;
  unclosedState?: UnclosedTagState;
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
  while (prefix < line.length && /\s/.test(line[prefix])) {
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
  if (state.blockComment) return consumeBlockCommentChar(line, index, state);
  if (state.quote) return consumeQuotedChar(line, index, state);
  return undefined;
}

function consumeStateStart(
  line: string,
  index: number,
  state: TagContentState,
  templateEnd: (index: number) => number,
): TagContentChunk | undefined {
  const pair = line.slice(index, index + 2);
  if (pair === "/*") {
    state.blockComment = true;
    return { js: pair, next: index + 2 };
  }
  const ch = line[index];
  if (ch === "`") {
    const end = templateEnd(index);
    if (end > 0) return { js: line.slice(index, end), next: end };
    state.quote = ch;
    return { js: ch, next: index + 1 };
  }
  if (ch === '"' || ch === "'") {
    state.quote = ch;
    return { js: ch, next: index + 1 };
  }
  return undefined;
}

/** Consume JS content until closing %> (or -%> / _%>); returns js text and new index. */
export function consumeTagContent(
  line: string,
  start: number,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): TagContentChunk {
  return createTagContentScanner(line, options)(start);
}

function consumeTagContentWithMatcher(
  line: string,
  start: number,
  options: EtaLanguageOptions,
  templateEnd: (index: number) => number,
): TagContentChunk {
  const state: TagContentState = {
    quote: undefined,
    blockComment: false,
  };
  let js = "";
  let i = start;

  while (i < line.length) {
    const chunk =
      consumeActiveTagState(line, i, state) ??
      consumeStateStart(line, i, state, templateEnd);
    if (chunk) {
      js += chunk.js;
      i = chunk.next;
      continue;
    }
    const closer = consumeTagCloser(line, i, options);
    if (closer) return { js: js + closer.js, next: closer.next, closed: true };
    js += line[i];
    i++;
  }
  let unclosedState: UnclosedTagState | undefined;
  if (state.quote) {
    unclosedState = "string";
  } else if (state.blockComment) {
    unclosedState = "block-comment";
  }
  return { js, next: i, unclosedState };
}

function consumeEtaTagRange(
  source: string,
  start: number,
  options: EtaLanguageOptions,
  consumeContent: TagContentScanner,
): EtaTagRange {
  const opener = consumeTagOpener(source, start, options);
  let cursor = opener.next;
  let content = "";
  let unclosedState: UnclosedTagState | undefined;

  while (cursor < source.length) {
    const consumed = consumeContent(cursor);
    content += consumed.js;
    unclosedState = consumed.unclosedState;
    cursor = consumed.next;
    if (consumed.closed) {
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
    unclosedState,
  };
}

export function findEtaTagRanges(
  source: string,
  options: EtaLanguageOptions = DEFAULT_ETA_LANGUAGE_OPTIONS,
): EtaTagRange[] {
  const ranges: EtaTagRange[] = [];
  let i = 0;
  const [open] = options.tags;
  const consumeContent = createTagContentScanner(source, options);

  while (i < source.length) {
    if (!source.startsWith(open, i)) {
      i++;
      continue;
    }

    const range = consumeEtaTagRange(source, i, options, consumeContent);
    ranges.push(range);
    i = Math.max(range.end, range.start + open.length);
  }

  return ranges;
}
