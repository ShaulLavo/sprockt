// What the preview does when the app loads, on every page. Kept apart from the transport so the
// landing page does not load the transport's code for it.
import { buildPreviewKind } from "./kind";
import { retirePreviewWorker } from "./retire";

/**
 * A build without mounted previews removes the mounted preview worker a build before it may
 * have left on this origin: a build with no previews, and one whose previews are isolated.
 */
export function retirePreviewsIfOff(): void {
  if (buildPreviewKind() === "mounted") return;
  retirePreviewWorker().catch((error: unknown) => console.error("Removing the preview worker failed", error));
}
