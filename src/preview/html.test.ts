import { expect, test } from "bun:test";
import { clientScriptTag, fallbackInsertion, headInsertion, injectTag, isHtml, isUtf8 } from "./html";

const TAG = "<script src=x></script>";

async function inject(chunks: readonly string[]): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(source.pipeThrough(injectTag(TAG))).text();
}

test("the script goes right after <head>, before the page's own scripts", async () => {
  const page =
    '<!doctype html><html><head><script type="module" src="/@vite/client"></script></head><body></body></html>';
  expect(await inject([page])).toBe(page.replace("<head>", `<head>${TAG}`));
});

test("it never lands before the doctype, with or without <head>", async () => {
  expect(await inject(['<!DOCTYPE html><html lang="en"><body><p>x</p></body></html>'])).toBe(
    `<!DOCTYPE html><html lang="en">${TAG}<body><p>x</p></body></html>`,
  );
  expect(await inject(["<!doctype html><p>no html element</p>"])).toBe(
    `<!doctype html>${TAG}<p>no html element</p>`,
  );
  expect(await inject(["<p>fragment</p>"])).toBe(`${TAG}<p>fragment</p>`);
  expect(await inject([""])).toBe(TAG);
});

test("a <head> tag split across chunks is still found, and the tag is inserted once", async () => {
  const output = await inject([
    "<!doctype html><html><he",
    'ad data-x="1"',
    "><title>t</title></head>",
    "<body>later</body>",
  ]);
  expect(output).toBe(
    `<!doctype html><html><head data-x="1">${TAG}<title>t</title></head><body>later</body>`,
  );
  expect(output.split(TAG)).toHaveLength(2);
});

test("<header> is not mistaken for <head>", () => {
  expect(headInsertion("<html><header>x</header>")).toBeUndefined();
  expect(headInsertion("<html><HEAD>")).toBe(12);
  expect(fallbackInsertion("<!doctype html><html><body>")).toBe(21);
});

test("text of more than one byte per character passes through intact", async () => {
  const page = "<html><head></head><body>héllo — 日本語 🎉</body></html>";
  const bytes = new TextEncoder().encode(page);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      // Cut in the middle of a character on purpose.
      controller.enqueue(bytes.subarray(0, 28));
      controller.enqueue(bytes.subarray(28));
      controller.close();
    },
  });
  const output = await new Response(source.pipeThrough(injectTag(TAG))).text();
  expect(output).toBe(page.replace("<head>", `<head>${TAG}`));
});

async function injectBytes(chunks: readonly Uint8Array[]): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(injectTag(TAG))).arrayBuffer());
}

test("a chunk that ends inside a character, in the chunk where the tag goes in, loses nothing", async () => {
  const page = "<html><head><title>café</title></head><body>日本語 🎉</body></html>";
  const bytes = new TextEncoder().encode(page);
  const expected = new TextEncoder().encode(page.replace("<head>", `<head>${TAG}`));
  // The first chunk holds <head>, so the tag goes in there, and ends between the two bytes of "é".
  const inside = new TextEncoder().encode("<html><head><title>caf").length + 1;
  expect(await injectBytes([bytes.subarray(0, inside), bytes.subarray(inside)])).toEqual(expected);
  // And the same for a cut at every other byte of the document.
  for (let cut = 1; cut < bytes.length; cut++) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await injectBytes([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual(expected);
  }
});

test("bytes that are not text at all come out unchanged around the tag", async () => {
  const head = new TextEncoder().encode("<html><head>");
  const junk = new Uint8Array([0xff, 0xfe, 0x80, 0x00, 0xc3]);
  const output = await injectBytes([head, junk]);
  expect(output.slice(0, head.length)).toEqual(head);
  expect(output.slice(output.length - junk.length)).toEqual(junk);
  expect(output.length).toBe(head.length + new TextEncoder().encode(TAG).length + junk.length);
});

test("a byte order mark stays first in a document with nothing to put the tag after", async () => {
  const mark = new Uint8Array([0xef, 0xbb, 0xbf]);
  const body = new TextEncoder().encode("<p>fragment</p>");
  const output = await injectBytes([new Uint8Array([...mark, ...body])]);
  expect(output.slice(0, 3)).toEqual(mark);
  expect(new TextDecoder().decode(output)).toBe(`${TAG}<p>fragment</p>`);
});

test("only HTML in UTF-8 is rewritten", () => {
  expect(isHtml("text/html; charset=utf-8")).toBe(true);
  expect(isHtml("TEXT/HTML")).toBe(true);
  expect(isHtml("text/htmlx")).toBe(false);
  expect(isHtml("application/json")).toBe(false);
  expect(isHtml(null)).toBe(false);
  expect(isUtf8("text/html")).toBe(true);
  expect(isUtf8('text/html; charset="UTF-8"')).toBe(true);
  expect(isUtf8("text/html; charset=iso-8859-1")).toBe(false);
});

test("the tag tells the client its port and where the server is mounted", () => {
  expect(clientScriptTag("abc", 5173)).toBe(
    '<script src="/preview-client.js" data-sprockt-port="5173" data-sprockt-mount="/__preview/abc/5173"></script>',
  );
});
