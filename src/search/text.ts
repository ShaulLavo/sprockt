// Finding a query in one file's text. Pure, so project search and its tests share one matcher.

export interface SearchQuery {
  readonly text: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

export interface LineMatch {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column of the match's first character, in UTF-16 code units. */
  readonly column: number;
  readonly length: number;
  /** The line's text, cut to a window around the match when the line is long. */
  readonly preview: string;
  /** Where the match starts inside `preview`. */
  readonly previewStart: number;
}

const PREVIEW_BEFORE = 40;
const PREVIEW_LENGTH = 200;

/** The matcher for a query, or an error message when the query is an invalid regular expression. */
export function compileQuery(query: SearchQuery): RegExp | string {
  if (!query.text) return "Empty query";
  const body = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = query.wholeWord ? `\\b(?:${body})\\b` : body;
  try {
    return new RegExp(source, query.caseSensitive ? "gu" : "giu");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function preview(lineText: string, column: number): { text: string; start: number } {
  if (lineText.length <= PREVIEW_LENGTH) return { text: lineText, start: column };
  const from = Math.max(0, column - PREVIEW_BEFORE);
  return { text: lineText.slice(from, from + PREVIEW_LENGTH), start: column - from };
}

/** Every match of `matcher` in `text`, up to `limit`, in order. `matcher` must be global. */
export function matchLines(text: string, matcher: RegExp, limit: number): LineMatch[] {
  const matches: LineMatch[] = [];
  let line = 1;
  let lineStart = 0;
  for (const found of text.matchAll(matcher)) {
    if (matches.length >= limit) break;
    // A pattern that matches nothing (`^`, `a*`) would only flood the panel with empty hits.
    if (found[0].length === 0) continue;
    const index = found.index;
    for (
      let next = text.indexOf("\n", lineStart);
      next !== -1 && next < index;
      next = text.indexOf("\n", next + 1)
    ) {
      line += 1;
      lineStart = next + 1;
    }
    const lineEnd = text.indexOf("\n", index);
    const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).replace(/\r$/, "");
    const column = index - lineStart;
    const shown = preview(lineText, column);
    matches.push({
      line,
      column: column + 1,
      length: Math.min(found[0].length, lineText.length - column),
      preview: shown.text,
      previewStart: shown.start,
    });
  }
  return matches;
}

/** Whether bytes look like a binary file: a NUL in the first 8 KiB, as Git and ripgrep decide. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

const decoder = new TextDecoder();

/** Matches of `query` in one file's bytes, up to `limit`; none for a binary file or a bad query. */
export function matchBytes(bytes: Uint8Array, query: SearchQuery, limit: number): LineMatch[] {
  if (looksBinary(bytes)) return [];
  const matcher = compileQuery(query);
  return typeof matcher === "string" ? [] : matchLines(decoder.decode(bytes), matcher, limit);
}
