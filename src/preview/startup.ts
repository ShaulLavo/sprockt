// What the preview does when the app loads, on every page. Kept apart from the transport so the
// landing page does not load the transport's code for it.
import { buildPreviewKind } from "./kind";
import { retirePreviewWorker } from "./retire";

/** A build without previews removes the preview worker a build before it may have left here. */
export function retirePreviewsIfOff(): void {
  if (buildPreviewKind() !== "none") return;
  retirePreviewWorker().catch((error: unknown) => console.error("Removing the preview worker failed", error));
}
