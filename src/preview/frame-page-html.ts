// The document of the page that shows an isolated preview in a tab of its own (frame-page.ts).
// A build with isolated previews publishes it at `/preview-frame` (vite-plugin.ts). It is not an
// entry of the app's build: it shares no chunk with the app, so the app's own page loads
// exactly what it loaded before, and this page loads one small script.
import { FRAME_PAGE_SCRIPT_PATH } from "./paths";

/** The attribute on the page's script that names the build's preview domain. */
export const DOMAIN_ATTRIBUTE = "data-preview-domain";

/** The preview fills its tab. The one line the page prints itself is a refusal (`role=status`). */
const STYLE =
  "html,body{height:100%;margin:0}" +
  "iframe{display:block;width:100%;height:100%;border:0}" +
  "p{margin:0;padding:24px;font:14px/1.5 system-ui,sans-serif}";

const escaped = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** `domain`: the build's preview domain, the only one whose origins the page will frame. */
export function framePageHtml(domain: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    '<meta name="color-scheme" content="light dark" />',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
    // The script replaces it with the preview's own title.
    "<title>Sprockt</title>",
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    `<script src="${FRAME_PAGE_SCRIPT_PATH}" ${DOMAIN_ATTRIBUTE}="${escaped(domain)}"></script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
