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
