import { expect, test } from "bun:test";
import { createQuickOpenSession } from "./quick-open-state";

test("Enter pressed before the first listing lands submits once that listing arrives", () => {
  const session = createQuickOpenSession();
  const first = session.beginListing();
  expect(session.submit(false)).toBe("wait");
  expect(session.finishListing(first)).toEqual({ accept: true, submit: true });
  // After the first listing, Enter submits immediately.
  expect(session.submit(false)).toBe("now");
});

test("changing the query clears a pending Enter before the first listing arrives", () => {
  const session = createQuickOpenSession();
  const first = session.beginListing();
  expect(session.submit(false)).toBe("wait");
  session.cancelPending();
  expect(session.finishListing(first)).toEqual({ accept: true, submit: false });
});

test("a failed first listing disarms a pending Enter so a later listing does not auto-submit", () => {
  const session = createQuickOpenSession();
  const first = session.beginListing();
  expect(session.submit(false)).toBe("wait");
  session.failListing(first);

  const retry = session.beginListing();
  expect(session.finishListing(retry)).toEqual({ accept: true, submit: false });
});

test("closing the dialog ignores late listings and never submits", () => {
  const session = createQuickOpenSession();
  const first = session.beginListing();
  expect(session.submit(false)).toBe("wait");
  session.close();
  expect(session.finishListing(first)).toEqual({ accept: false, submit: false });
});

test("commands-only queries submit immediately without waiting for the file listing", () => {
  const session = createQuickOpenSession();
  const first = session.beginListing();
  expect(session.submit(true)).toBe("now");
  expect(session.finishListing(first)).toEqual({ accept: true, submit: false });
});

test("a superseded earlier listing is ignored while the newest listing still honors an unchanged pending Enter", () => {
  const session = createQuickOpenSession();
  const first = session.beginListing();
  expect(session.submit(false)).toBe("wait");
  const second = session.beginListing();
  expect(session.finishListing(first)).toEqual({ accept: false, submit: false });
  expect(session.finishListing(second)).toEqual({ accept: true, submit: true });
});
