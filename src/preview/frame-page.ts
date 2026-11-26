// The script of the page behind "open preview in new tab" for isolated previews
// (`/preview-frame`, frame-page-html.ts). A tab opened on a preview origin itself cannot reach
// the IDE tab's connection in every browser (Safari keeps a framed origin's service worker
// apart from a top-level tab's), and the preview hosts refuse it. A frame inside a tab of the
// IDE's origin shares the service worker with the IDE tab, so the link opens this page, and it
// frames the preview.
//
// It runs none of the app: only bun-wasm's `showPreviewFrame`, which frames nothing but a
// preview origin of this build's domain, cuts the tab's way back to its opener, and follows the
// preview's title and address. The page is served with `Cross-Origin-Opener-Policy:
// same-origin`, like every page of the IDE.
import { showPreviewFrame } from "bun-wasm/preview-origins";
import { ui } from "./copy";
import { DOMAIN_ATTRIBUTE } from "./frame-page-html";

const domain = document.currentScript?.getAttribute(DOMAIN_ATTRIBUTE);
document.title = ui.preview;
showPreviewFrame(domain ? { domain } : null);
