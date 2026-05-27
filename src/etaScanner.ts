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
  end: number;
  closed: boolean;
  empty: boolean;
}

/** Consume the <% opener and its modifier chars; returns chars consumed and new index. */
export function consumeTagOpener(
  line: string,
  start: number,
): { padLen: number; next: number } {
  let i = start + 2; // skip <%
  if (i < line.length && (line[i] === "-" || line[i] === "_")) {
    i++;
  }
  let prefix = i;
  while (prefix < line.length && /[ \t]/.test(line[prefix])) {
    prefix++;
  }
  if (prefix < line.length && "=~#*@".includes(line[prefix])) {
    i = prefix + 1; // tag prefix, e.g. <%=, <%~, <%- =, <%@
  }
  return { padLen: i - start, next: i };
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
): TagContentChunk | undefined {
  if (line[index] === "%" && line[index + 1] === ">") {
    return { js: "  ", next: index + 2 };
  }
  if (
    (line[index] === "-" || line[index] === "_") &&
    line[index + 1] === "%" &&
    line[index + 2] === ">"
  ) {
    return { js: "   ", next: index + 3 };
  }
  return undefined;
}

/** Consume JS content until closing %> (or -%> / _%>); returns js text and new index. */
export function consumeTagContent(
  line: string,
  start: number,
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
    const closer = consumeTagCloser(line, i);
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
): boolean {
  return (
    to > from &&
    (source.slice(to - 2, to) === "%>" ||
      /^[-_]%>$/.test(source.slice(to - 3, to)))
  );
}

function consumeEtaTagRange(source: string, start: number): EtaTagRange {
  const opener = consumeTagOpener(source, start);
  let cursor = opener.next;
  let content = "";

  while (cursor < source.length) {
    const consumed = consumeTagContent(source, cursor);
    content += consumed.js;
    cursor = consumed.next;
    if (isClosedTagContent(source, opener.next, cursor)) {
      return {
        start,
        end: cursor,
        closed: true,
        empty: content.trim().length === 0,
      };
    }
  }

  return {
    start,
    end: cursor,
    closed: false,
    empty: content.trim().length === 0,
  };
}

export function findEtaTagRanges(source: string): EtaTagRange[] {
  const ranges: EtaTagRange[] = [];
  let i = 0;

  while (i < source.length) {
    if (source[i] !== "<" || source[i + 1] !== "%") {
      i++;
      continue;
    }

    const range = consumeEtaTagRange(source, i);
    ranges.push(range);
    i = Math.max(range.end, range.start + 2);
  }

  return ranges;
}
