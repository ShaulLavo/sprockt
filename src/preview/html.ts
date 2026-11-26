// Adds the preview client script to HTML that streams through the service worker. The script
// must run before the page's own scripts, and must not come before the doctype (that would put
// the page in quirks mode), so it goes right after the opening <head> tag.
import { CLIENT_SCRIPT_PATH, serverMount } from "./paths";

/** How much of a document is searched for <head> before the script is placed without one. */
const SEARCH_LIMIT = 16_384;

/** The client learns from the tag which server it belongs to and where that server is mounted. */
export function clientScriptTag(workspace: string, port: number): string {
  const mount = serverMount(workspace, port);
  return `<script src="${CLIENT_SCRIPT_PATH}" data-sprockt-port="${port}" data-sprockt-mount="${mount}"></script>`;
}

export function isHtml(contentType: string | null): boolean {
  return /^text\/html\b/i.test(contentType ?? "");
}

/** UTF-8 is assumed unless the header names another charset; then the page is left alone. */
export function isUtf8(contentType: string | null): boolean {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1];
  return !charset || /^utf-?8$/i.test(charset);
}

const endOf = (html: string, pattern: RegExp): number | undefined => {
  const match = pattern.exec(html);
  return match ? match.index + match[0].length : undefined;
};

/**
 * Where the script goes in the text seen so far: after <head>, or undefined while the document
 * may still bring one.
 */
export function headInsertion(html: string): number | undefined {
  return endOf(html, /<head(?:\s[^>]*)?>/i);
}

/** A UTF-8 byte order mark, as the one-character-per-byte text below shows it. */
const BYTE_ORDER_MARK = "ï»¿";

/**
 * Where the script goes in a document without <head>: after <html>, else after the doctype,
 * else at the start (after a byte order mark, which has to stay first).
 */
export function fallbackInsertion(html: string): number {
  const start = html.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  return endOf(html, /<html(?:\s[^>]*)?>/i) ?? endOf(html, /<!doctype[^>]*>/i) ?? start;
}

/** True once waiting for <head> is pointless: the body or a script began, or enough was read. */
function pastHead(html: string): boolean {
  return html.length > SEARCH_LIMIT || /<(?:body|script)[\s>]/i.test(html);
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.length;
  }
  return whole;
}

/**
 * A stream transform that inserts `tag` once and then passes the rest through untouched.
 *
 * The document's bytes are never decoded and encoded again: a chunk may end in the middle of a
 * character, and the bytes after the insertion pass through as they came. The place is found in
 * a one-character-per-byte reading of what arrived, so an index into that text is an index into
 * the bytes; the tags looked for are ASCII, which reads the same in UTF-8.
 */
export function injectTag(tag: string): TransformStream<Uint8Array, Uint8Array> {
  const tagBytes = new TextEncoder().encode(tag);
  const byteText = new TextDecoder("latin1");
  let pending: Uint8Array[] = [];
  let seen = "";
  let done = false;

  function release(controller: TransformStreamDefaultController<Uint8Array>, index: number): void {
    done = true;
    const bytes = joined(pending);
    if (index > 0) controller.enqueue(bytes.subarray(0, index));
    controller.enqueue(tagBytes);
    if (index < bytes.length) controller.enqueue(bytes.subarray(index));
    pending = [];
    seen = "";
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (done) return controller.enqueue(chunk);
      pending.push(chunk);
      seen += byteText.decode(chunk);
      const head = headInsertion(seen);
      if (head !== undefined) return release(controller, head);
      if (pastHead(seen)) release(controller, fallbackInsertion(seen));
    },
    flush(controller) {
      if (done) return;
      release(controller, headInsertion(seen) ?? fallbackInsertion(seen));
    },
  });
}
