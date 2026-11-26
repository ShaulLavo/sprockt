import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Scope, useScope } from "./react";
import { createRoot, onCleanup } from "./reactive";

test("useScope does not run its factory or leak cleanups when a render never commits", () => {
  let started = 0;
  let cleaned = 0;

  function Abandoned() {
    const value = useScope(() => {
      started++;
      onCleanup(() => cleaned++);
      return "live";
    });
    return createElement("span", null, value ?? "pending");
  }

  const html = renderToStaticMarkup(createElement(Abandoned));
  expect(html).toBe("<span>pending</span>");
  expect(started).toBe(0);
  expect(cleaned).toBe(0);
});

test("Scope renders its fallback when a render never commits", () => {
  let started = 0;

  function AbandonedScope() {
    return createElement(Scope<string>, {
      create: () => {
        started++;
        return "live";
      },
      fallback: createElement("span", null, "loading"),
      children: (value: string) => createElement("span", null, value),
    });
  }

  expect(renderToStaticMarkup(createElement(AbandonedScope))).toBe("<span>loading</span>");
  expect(started).toBe(0);
});

test("createRoot disposes cleanups already registered when its factory throws", () => {
  let cleaned = 0;
  expect(() =>
    createRoot(() => {
      onCleanup(() => cleaned++);
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(cleaned).toBe(1);
});
