// Runs project-search matching off the page's thread. The page terminates this worker to cancel
// a search, which also stops a regular expression that would otherwise backtrack for ever.
import { matchBytes, type LineMatch, type SearchQuery } from "./text";

export interface MatchRequest {
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly query: SearchQuery;
  readonly limit: number;
}

export interface MatchReply {
  readonly id: number;
  readonly matches: readonly LineMatch[];
}

addEventListener("message", (event: MessageEvent<MatchRequest>) => {
  const { id, bytes, query, limit } = event.data;
  const reply: MatchReply = { id, matches: matchBytes(bytes, query, limit) };
  postMessage(reply);
});
