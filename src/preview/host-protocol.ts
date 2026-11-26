// What the preview service worker and the IDE tabs say to each other, on top of Waffle's own
// preview messages.
import type { PreviewMessage } from "waffle/browser/preview-protocol";

/** Worker to tabs, when it starts: "tell me which workspace you host". */
export const HOST_QUERY = "preview-hosts-query";

/** Tab to worker: "I host this workspace's servers". */
export interface HostAnnouncement {
  readonly type: "preview-host";
  readonly workspace: string;
}

/**
 * Page to worker, from a build without previews: "stop serving and remove yourself". A worker
 * that an earlier build registered would otherwise keep routing to that build's open tabs.
 */
export const PREVIEWS_OFF = "previews-off";

export function isPreviewsOff(value: unknown): boolean {
  return hasType(value) && value.type === PREVIEWS_OFF;
}

/** A Waffle preview request, tagged with the workspace it is for. */
export type HostAsk = PreviewMessage & { readonly workspace: string };

const hasType = (value: unknown): value is { type: unknown } & Record<string, unknown> =>
  typeof value === "object" && value !== null && "type" in value;

export function hostAnnouncement(workspace: string): HostAnnouncement {
  return { type: "preview-host", workspace };
}

export function isHostAnnouncement(value: unknown): value is HostAnnouncement {
  return hasType(value) && value.type === "preview-host" && typeof value.workspace === "string";
}

export function isHostQuery(value: unknown): boolean {
  return hasType(value) && value.type === HOST_QUERY;
}

/** The workspace a request from the worker is for, or undefined when it is not such a request. */
export function askedWorkspace(value: unknown): string | undefined {
  if (!hasType(value) || typeof value.type !== "string" || !value.type.startsWith("preview-"))
    return undefined;
  return typeof value.workspace === "string" ? value.workspace : undefined;
}
