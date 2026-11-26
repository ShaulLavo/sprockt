// Messages between the preview pane and the client script inside a previewed page. They go
// through window.postMessage, so they work the same whether the page shares our origin
// (mounted previews) or has its own (isolated previews).

const SOURCE = "sprockt-preview";

/** From the previewed page to the IDE. */
export type FrameMessage =
  /** A new document started loading; errors from the previous one no longer apply. */
  | { readonly source: typeof SOURCE; readonly type: "started"; readonly href: string }
  /** The page is at `href` now: after a load, a history change or a hash change. */
  | {
      readonly source: typeof SOURCE;
      readonly type: "location";
      readonly href: string;
      readonly title: string;
    }
  /** An uncaught error, an unhandled rejection or a console.error call. */
  | { readonly source: typeof SOURCE; readonly type: "error"; readonly message: string }
  /** The answer to the pane's `hello`: this document runs our script and takes commands. */
  | { readonly source: typeof SOURCE; readonly type: "hello"; readonly id: number };

/** From the IDE to the previewed page. */
export type FrameCommand =
  /** Asked of every document that finishes loading in the frame (greeting.ts). */
  | { readonly source: typeof SOURCE; readonly command: "hello"; readonly id: number }
  | { readonly source: typeof SOURCE; readonly command: "reload" }
  | { readonly source: typeof SOURCE; readonly command: "navigate"; readonly href: string };

type Body<T> = T extends unknown ? Omit<T, "source"> : never;

export function frameMessage(body: Body<FrameMessage>): FrameMessage {
  return { source: SOURCE, ...body };
}

export function frameCommand(body: Body<FrameCommand>): FrameCommand {
  return { source: SOURCE, ...body };
}

const hasSource = (value: unknown): value is { source: typeof SOURCE } & Record<string, unknown> =>
  typeof value === "object" && value !== null && "source" in value && value.source === SOURCE;

const isText = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number => Number.isSafeInteger(value);

export function isFrameMessage(value: unknown): value is FrameMessage {
  if (!hasSource(value)) return false;
  if (value.type === "started") return isText(value.href);
  if (value.type === "location") return isText(value.href) && isText(value.title);
  if (value.type === "hello") return isCount(value.id);
  return value.type === "error" && isText(value.message);
}

export function isFrameCommand(value: unknown): value is FrameCommand {
  if (!hasSource(value)) return false;
  if (value.command === "hello") return isCount(value.id);
  if (value.command === "reload") return true;
  return value.command === "navigate" && isText(value.href);
}
