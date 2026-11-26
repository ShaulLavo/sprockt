import { expect, test } from "bun:test";
import { createGreeting } from "./greeting";

test("nothing understands before it has answered", () => {
  const greeting = createGreeting();
  expect(greeting.understood).toBe(false);
  greeting.ask();
  expect(greeting.understood).toBe(false);
});

test("a document that answers its greeting takes commands", () => {
  const greeting = createGreeting();
  greeting.answer(greeting.ask());
  expect(greeting.understood).toBe(true);
});

test("the next document starts over: a page without our script after one with it is not commanded", () => {
  const greeting = createGreeting();
  greeting.answer(greeting.ask());
  // The frame lands on a refusal, an image or a download, which answers nothing.
  greeting.ask();
  expect(greeting.understood).toBe(false);
});

test("an answer that was on its way when the next document loaded says nothing about that one", () => {
  const greeting = createGreeting();
  const first = greeting.ask();
  greeting.ask();
  greeting.answer(first);
  expect(greeting.understood).toBe(false);
  // Nor does a number the page made up.
  greeting.answer(99);
  greeting.answer(-1);
  expect(greeting.understood).toBe(false);
});
