// Quick open's ranking. A query matches a path when its characters appear in order. Matches in the
// file name, at word starts and in runs score higher; shorter paths win ties. One pass per path and
// no allocation for paths that do not match keeps a keystroke over 10,000 files in a few ms.

export interface FuzzyMatch {
  readonly path: string;
  readonly score: number;
  /** Indexes into `path` of the matched characters, for highlighting. */
  readonly positions: readonly number[];
}

const SEPARATORS = new Set(["/", ".", "-", "_", " "]);

function isBoundary(path: string, index: number): boolean {
  if (index === 0) return true;
  const previous = path[index - 1] as string;
  if (SEPARATORS.has(previous)) return true;
  const current = path[index] as string;
  return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

/** Greedy in-order match of `query` (already lower case) in `path` from `start`; null when absent. */
function matchFrom(query: string, path: string, lower: string, start: number): FuzzyMatch | null {
  // Cheap rejection before any bookkeeping: most paths do not contain the query at all.
  let probe = start;
  for (const char of query) {
    probe = lower.indexOf(char, probe);
    if (probe < 0) return null;
    probe += 1;
  }
  const positions: number[] = [];
  let score = 0;
  let previous = -2;
  let at = start;
  for (const char of query) {
    const index = lower.indexOf(char, at);
    let gain = 1;
    if (index === previous + 1) gain += 5;
    if (isBoundary(path, index)) gain += 8;
    score += gain;
    positions.push(index);
    previous = index;
    at = index + 1;
  }
  return { path, score, positions };
}

/** Scores one path, or returns null when the query's characters do not all appear in order. */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const needle = query.replaceAll(" ", "").toLowerCase();
  if (!needle) return { path, score: 0, positions: [] };
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const inName = matchFrom(needle, path, lower, nameStart);
  const match = inName ?? matchFrom(needle, path, lower, 0);
  if (!match) return null;
  const name = lower.slice(nameStart);
  let bonus = inName ? 20 : 0;
  if (name.startsWith(needle)) bonus += 20;
  if (name === needle || name.slice(0, name.lastIndexOf(".")) === needle) bonus += 30;
  return { path, score: match.score + bonus - path.length * 0.05, positions: match.positions };
}

/** Splits a trailing `:line` or `:line:column` off a quick-open query. */
export function splitLocation(query: string): { text: string; line?: number; column?: number } {
  const found = /^(.*?):(\d+)(?::(\d+))?$/.exec(query.trim());
  if (!found) return { text: query.trim() };
  const line = Number(found[2]);
  const column = found[3] === undefined ? undefined : Number(found[3]);
  return { text: found[1] as string, line: line > 0 ? line : undefined, column };
}

/** The best `limit` matches, best first; ties go to the shorter, then alphabetically earlier path. */
export function rankPaths(query: string, paths: readonly string[], limit: number): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  for (const path of paths) {
    const match = fuzzyMatch(query, path);
    if (match) matches.push(match);
  }
  matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  matches.length = Math.min(matches.length, limit);
  return matches;
}
