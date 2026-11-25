import { expect, test } from "bun:test";
import { isolationHeaders } from "./isolation";

test("an ordinary HTML response gets all three policies, so its own tab is cross-origin isolated", () => {
  const headers = isolationHeaders(new Headers({ "content-type": "text/html; charset=utf-8" }));
  expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(headers.get("content-type")).toBe("text/html; charset=utf-8");
});

test("a policy the server set itself is kept", () => {
  const headers = isolationHeaders(
    new Headers({
      "cross-origin-opener-policy": "same-origin-allow-popups",
      "cross-origin-resource-policy": "cross-origin",
    }),
  );
  expect(headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
  expect(headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  expect(headers.get("cross-origin-embedder-policy")).toBe("require-corp");
});
