// The headers every previewed response carries. The IDE is cross-origin isolated, so a preview
// framed in it has to opt in as well (the embedder and resource policies). A preview opened in
// its own tab is a top-level document: it gets `SharedArrayBuffer` only with an opener policy
// too, which a frame ignores. What the server set itself is kept.
const ISOLATION: readonly (readonly [string, string])[] = [
  ["cross-origin-opener-policy", "same-origin"],
  ["cross-origin-embedder-policy", "require-corp"],
  ["cross-origin-resource-policy", "same-origin"],
];

export function isolationHeaders(headers: Headers): Headers {
  for (const [name, value] of ISOLATION) if (!headers.has(name)) headers.set(name, value);
  return headers;
}
