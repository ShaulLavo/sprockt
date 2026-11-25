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

/** Where the script goes in a document without <head>: after <html>, else after the doctype. */
export function fallbackInsertion(html: string): number {
  return endOf(html, /<html(?:\s[^>]*)?>/i) ?? endOf(html, /<!doctype[^>]*>/i) ?? 0;
}

/** True once waiting for <head> is pointless: the body or a script began, or enough was read. */
function pastHead(html: string): boolean {
  return html.length > SEARCH_LIMIT || /<(?:body|script)[\s>]/i.test(html);
}

const insertAt = (html: string, index: number, tag: string) => html.slice(0, index) + tag + html.slice(index);

/** A stream transform that inserts `tag` once and then passes the rest through untouched. */
export function injectTag(tag: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let done = false;

  function release(controller: TransformStreamDefaultController<Uint8Array>, index: number): void {
    done = true;
    controller.enqueue(encoder.encode(insertAt(pending, index, tag)));
    pending = "";
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (done) return controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const head = headInsertion(pending);
      if (head !== undefined) return release(controller, head);
      if (pastHead(pending)) release(controller, fallbackInsertion(pending));
    },
    flush(controller) {
      if (done) return;
      pending += decoder.decode();
      release(controller, headInsertion(pending) ?? fallbackInsertion(pending));
    },
  });
}
