import { expect, test } from "bun:test";
import { Documents, type SaveRequest } from "./documents";

const never = () => {
  throw new Error("the text on screen should not have been read");
};

function shownWith(text: string) {
  const documents = new Documents();
  documents.select("a.txt");
  documents.show("a.txt", text, never);
  return documents;
}

function saveRequest(documents: Documents): SaveRequest {
  const request = documents.beginSave();
  if (!request) throw new Error("nothing is on screen");
  return request;
}

/** Shows `path` as the pane does: select it, then deliver its read. */
function open(documents: Documents, path: string, diskText: string, leavingText: () => string = never) {
  documents.select(path);
  return documents.show(path, diskText, leavingText);
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
  expect(open(documents, "b.txt", "B", () => "A edited")).toBe("B");
  expect(documents.dirty).toBe(false);
  expect(documents.hasUnsaved("a.txt")).toBe(true);

  expect(open(documents, "a.txt", "A")).toBe("A edited");
  expect(documents.dirty).toBe(true);
  expect(documents.beginSave()?.baseText).toBe("A");
});

test("an edit reported after its file left the screen does not mark the file now shown", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  open(documents, "b.txt", "B", () => "A edited");
  documents.edited("a.txt");
  expect(documents.dirty).toBe(false);
  expect(documents.hasUnsaved("a.txt")).toBe(true);
});

test("a finished save clears dirty only for the edits it contained", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  const first = saveRequest(documents);
  documents.edited("a.txt");
  documents.saved(first, "A1");
  expect(documents.dirty).toBe(true);

  documents.saved(saveRequest(documents), "A2");
  expect(documents.dirty).toBe(false);
  expect(documents.beginSave()?.baseText).toBe("A2");
});

test("a save still pending across A, B, A cannot clear edits made after coming back", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  documents.edited("a.txt");
  const pending = saveRequest(documents);

  open(documents, "b.txt", "B", () => "A two edits");
  expect(open(documents, "a.txt", "A", never)).toBe("A two edits");
  documents.edited("a.txt");

  // The save started before the switch contained two edits; there are three now.
  documents.saved(pending, "A two edits");
  expect(documents.dirty).toBe(true);

  open(documents, "b.txt", "B", () => "A three edits");
  expect(open(documents, "a.txt", "A two edits", never)).toBe("A three edits");
});

test("a save that finishes after its file left the screen leaves nothing unsaved", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  const request = saveRequest(documents);
  open(documents, "b.txt", "B", () => "A edited");
  documents.saved(request, "A edited");
  expect(documents.hasUnsaved("a.txt")).toBe(false);
  expect(open(documents, "a.txt", "A edited", never)).toBe("A edited");
  expect(documents.dirty).toBe(false);
});

test("a refused save keeps the edits and offers both versions", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  documents.conflicted(saveRequest(documents), "A from the shell");
  expect(documents.conflict).toEqual({ path: "a.txt", diskText: "A from the shell" });
  expect(documents.dirty).toBe(true);

  documents.keepMine();
  expect(documents.conflict).toBeUndefined();
  expect(documents.beginSave()?.baseText).toBe("A from the shell");
});

test("a conflict belongs to its document: it is not offered while another file is shown", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  const request = saveRequest(documents);
  open(documents, "b.txt", "B", () => "A edited");
  documents.conflicted(request, "A from the shell");

  expect(documents.conflict).toBeUndefined();
  documents.keepMine();
  expect(documents.beginSave()).toEqual({ path: "b.txt", generation: 0, baseText: "B" });

  open(documents, "a.txt", "A from the shell", never);
  expect(documents.conflict).toEqual({ path: "a.txt", diskText: "A from the shell" });
});

test("taking the version on disk drops the edits", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  documents.conflicted(saveRequest(documents), "A from the shell");
  expect(documents.takeTheirs()).toBe("A from the shell");
  expect(documents.dirty).toBe(false);
  expect(documents.conflict).toBeUndefined();
  expect(documents.unsaved(never).size).toBe(0);
});

test("a write acknowledged from memory stays recoverable until storage holds it", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  const request = saveRequest(documents);
  documents.saved(request, "A saved");

  // Not dirty any more, but the flush has not finished: losing storage now would lose it.
  expect(documents.dirty).toBe(false);
  expect(Object.fromEntries(documents.unsaved(() => "A saved"))).toEqual({
    "a.txt": { text: "A saved", baseText: "A" },
  });

  documents.durable(request, "A saved");
  expect(documents.unsaved(never).size).toBe(0);
});

test("an undurable write is still recoverable after its file left the screen", () => {
  const documents = shownWith("A");
  documents.edited("a.txt");
  const request = saveRequest(documents);
  documents.saved(request, "A saved");
  open(documents, "b.txt", "B", () => "A saved");

  expect(Object.fromEntries(documents.unsaved(() => "B"))).toEqual({
    "a.txt": { text: "A saved", baseText: "A" },
  });
  documents.durable(request, "A saved");
  expect(documents.unsaved(() => "B").size).toBe(0);
});

test("text recovered from another tab is shown as unsaved and stays recoverable", () => {
  const documents = new Documents((path) =>
    path === "a.txt" ? { text: "left behind", baseText: "A" } : undefined,
  );
  expect(open(documents, "a.txt", "A")).toBe("left behind");
  expect(documents.dirty).toBe(true);
  expect(Object.fromEntries(documents.unsaved(() => "left behind"))).toEqual({
    "a.txt": { text: "left behind", baseText: "A" },
  });
});

test("unsaved() lists the text on screen and every kept text, for any file name", () => {
  const documents = new Documents();
  open(documents, "constructor", "C");
  documents.edited("constructor");
  open(documents, "b.txt", "B", () => "C edited");
  documents.edited("b.txt");
  expect(Array.from(documents.unsaved(() => "B edited"))).toEqual([
    ["constructor", { text: "C edited", baseText: "C" }],
    ["b.txt", { text: "B edited", baseText: "B" }],
  ]);
});
