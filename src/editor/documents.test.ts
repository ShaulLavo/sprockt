import { expect, test } from "bun:test";
import { Documents } from "./documents";

const never = () => {
  throw new Error("the text on screen should not have been read");
};

function shownWith(text: string) {
  const documents = new Documents();
  documents.select("a.txt");
  documents.show("a.txt", text, never);
  return documents;
}

test("a save while the next file is still loading targets the file on screen", () => {
  const documents = shownWith("A on disk");
  documents.edited("a.txt");
  documents.select("b.txt");

  // b.txt has been selected but not read yet: the editor still shows a.txt.
  expect(documents.selected).toBe("b.txt");
  expect(documents.displayed).toBe("a.txt");
  expect(documents.beginSave()).toEqual({ path: "a.txt", generation: 1, baseText: "A on disk" });
});

test("selecting the selected file again keeps its unsaved state", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  expect(documents.select("a.txt")).toBe(false);
  expect(documents.dirty).toBe(true);
});

test("a read that finishes after the selection moved on is ignored", () => {
  const documents = shownWith("A");
  documents.select("b.txt");
  documents.select("c.txt");
  expect(documents.show("b.txt", "B", never)).toBeUndefined();
  expect(documents.displayed).toBe("a.txt");
});

test("unsaved text is kept when another file is shown, and comes back dirty", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  documents.select("b.txt");
  expect(documents.show("b.txt", "B", () => "A edited")).toBe("B");
  expect(documents.dirty).toBe(false);
  expect(documents.hasUnsaved("a.txt")).toBe(true);

  documents.select("a.txt");
  expect(documents.show("a.txt", "A", never)).toBe("A edited");
  expect(documents.dirty).toBe(true);
  expect(documents.beginSave()?.baseText).toBe("A");
});

test("an edit reported after its file left the screen does not mark the file now shown", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  documents.select("b.txt");
  documents.show("b.txt", "B", () => "A edited");
  documents.edited("a.txt");
  expect(documents.dirty).toBe(false);
  expect(documents.hasUnsaved("a.txt")).toBe(true);
});

test("a finished save clears dirty only for the edits it contained", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  const request = documents.beginSave();
  documents.edited("a.txt");
  if (request) documents.saved(request, "A1");
  expect(documents.dirty).toBe(true);

  const second = documents.beginSave();
  if (second) documents.saved(second, "A2");
  expect(documents.dirty).toBe(false);
  expect(documents.beginSave()?.baseText).toBe("A2");
});

test("a save that finishes after its file left the screen settles that file's draft", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  const request = documents.beginSave();
  documents.select("b.txt");
  documents.show("b.txt", "B", () => "A edited");
  if (request) documents.saved(request, "A edited");
  expect(documents.hasUnsaved("a.txt")).toBe(false);
  expect(documents.dirty).toBe(false);
});

test("a refused save keeps the edits and offers both versions", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  const request = documents.beginSave();
  if (request) documents.conflicted(request, "A from the shell");
  expect(documents.conflict).toEqual({ path: "a.txt", diskText: "A from the shell" });
  expect(documents.dirty).toBe(true);

  documents.keepMine();
  expect(documents.conflict).toBeUndefined();
  expect(documents.beginSave()?.baseText).toBe("A from the shell");
});

test("taking the version on disk drops the edits", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  const request = documents.beginSave();
  if (request) documents.conflicted(request, "A from the shell");
  expect(documents.takeTheirs()).toBe("A from the shell");
  expect(documents.dirty).toBe(false);
  expect(documents.conflict).toBeUndefined();
});

test("text recovered from another tab is shown as unsaved", () => {
  const documents = new Documents((path) =>
    path === "a.txt" ? { text: "left behind", baseText: "A" } : undefined,
  );
  documents.select("a.txt");
  expect(documents.show("a.txt", "A", never)).toBe("left behind");
  expect(documents.dirty).toBe(true);
});

test("unsaved() lists the text on screen and every draft", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  documents.select("b.txt");
  documents.show("b.txt", "B", () => "A edited");
  documents.edited("b.txt");
  expect(documents.unsaved(() => "B edited")).toEqual({
    "a.txt": { text: "A edited", baseText: "A" },
    "b.txt": { text: "B edited", baseText: "B" },
  });
});
