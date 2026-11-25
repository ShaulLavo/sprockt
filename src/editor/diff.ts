/** One replacement that turns `before` into `after`: the span between their common prefix and suffix. */
export interface Replacement {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/**
 * The smallest single edit from `before` to `after`, or null when they are equal. Reloading a
 * buffer this way keeps carets and scroll positions outside the changed span where they were.
 */
export function replacementBetween(before: string, after: string): Replacement | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  // Never split a surrogate pair: back up to the pair's first half.
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start -= 1;
  let end = 0;
  const room = limit - start;
  while (
    end < room &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) {
    end += 1;
  }
  if (end > 0 && isLowSurrogate(before.charCodeAt(before.length - end))) end -= 1;
  return { from: start, to: before.length - end, text: after.slice(start, after.length - end) };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
