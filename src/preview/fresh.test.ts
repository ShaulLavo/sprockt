import { expect, test } from "bun:test";
import { freshly } from "./fresh";

/** Questions the test answers by hand, in the order they were asked. */
function questions() {
  const asked: PromiseWithResolvers<string>[] = [];
  const ask = (): Promise<string> => {
    const question = Promise.withResolvers<string>();
    asked.push(question);
    return question.promise;
  };
  return { asked, ask };
}

test("a caller with no question out asks one", async () => {
  const { asked, ask } = questions();
  const fresh = freshly(ask);
  const answer = fresh();
  expect(asked).toHaveLength(1);
  asked[0]?.resolve("first");
  expect(await answer).toBe("first");
});

test("a caller that comes while a question is out never gets that question's answer", async () => {
  const { asked, ask } = questions();
  const fresh = freshly(ask);
  const early = fresh();
  const late = fresh();
  const later = fresh();
  // Nothing new is asked until the question that is out has come back.
  expect(asked).toHaveLength(1);
  asked[0]?.resolve("old");
  expect(await early).toBe("old");
  await Promise.resolve();
  // The two that waited share one new question, asked after both had come.
  expect(asked).toHaveLength(2);
  asked[1]?.resolve("new");
  expect(await Promise.all([late, later])).toEqual(["new", "new"]);
  expect(asked).toHaveLength(2);
});

test("once everything has been answered, the next caller asks again: nothing is kept", async () => {
  const { asked, ask } = questions();
  const fresh = freshly(ask);
  const first = fresh();
  asked[0]?.resolve("one");
  await first;
  const second = fresh();
  expect(asked).toHaveLength(2);
  asked[1]?.resolve("two");
  expect(await second).toBe("two");
});
