// Reading a preview that lives on an origin of its own. Playwright's Firefox driver does not see
// every cross-origin frame (it kept reporting a loaded preview as `about:blank`), so these tests
// never look at a preview through the driver's frames. The test's server puts a small script in
// its pages, and the test asks it through `window.postMessage` from the page around the frame,
// which is also the only way the IDE itself can talk to such a page.
import { expect, type Page } from "@playwright/test";

/** The script a test server adds to its pages: it runs what the embedding page sends and answers. */
export const PROBE = `(() => {
  if (window.previewProbe) return;
  window.previewProbe = true;
  addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data.previewProbe !== "number") return;
    const reply = (body) => event.source.postMessage({ previewProbeReply: data.previewProbe, ...body }, "*");
    Promise.resolve()
      .then(() => (0, eval)(data.code))
      .then((value) => reply({ value }), (error) => reply({ error: String(error) }));
  });
})();`;

export const PREVIEW_FRAME = "[data-testid=wb-preview-iframe]";

interface Reply {
  readonly value?: unknown;
  readonly error?: string;
  readonly missing?: true;
}

/** How long one question waits for its answer before the caller asks again. */
const ANSWER_MS = 1000;

function ask(page: Page, code: string, selector: string): Promise<Reply> {
  return page.evaluate(
    ([source, frameSelector, wait]) =>
      new Promise<Reply>((resolve) => {
        const target = document.querySelector<HTMLIFrameElement>(frameSelector)?.contentWindow;
        if (!target) return resolve({ missing: true });
        const id = Math.random();
        const finish = (reply: Reply): void => {
          clearTimeout(timer);
          removeEventListener("message", receive);
          resolve(reply);
        };
        const receive = (event: MessageEvent<(Reply & { previewProbeReply?: number }) | null>): void => {
          if (event.source === target && event.data?.previewProbeReply === id) finish(event.data);
        };
        // No answer: the frame holds a page without the probe, or none yet.
        const timer = setTimeout(finish, wait, { missing: true });
        addEventListener("message", receive);
        // The frame's origin is the thing under test, so the question goes to whatever is there.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        target.postMessage({ previewProbe: id, code: source }, "*");
      }),
    [code, selector, ANSWER_MS] as const,
  );
}

/**
 * Runs `read` inside the previewed page and returns its result, or undefined while the frame
 * holds no page that answers. `read` is sent as source text, so it sees only its argument.
 */
export async function inPreview<Result, Argument = undefined>(
  page: Page,
  read: (argument: Argument) => Result,
  argument?: Argument,
  selector: string = PREVIEW_FRAME,
): Promise<Awaited<Result> | undefined> {
  const reply = await ask(page, `(${read.toString()})(${JSON.stringify(argument)})`, selector);
  if (reply.error !== undefined) throw new Error(`The previewed page threw: ${reply.error}`);
  return reply.value as Awaited<Result> | undefined;
}

/** The text of the first element matching `selector` in the previewed page. */
export const previewText = (page: Page, selector: string, frame?: string): Promise<string | undefined> =>
  inPreview(page, (query) => document.querySelector(query)?.textContent ?? undefined, selector, frame);

export interface PreviewWait {
  /** The frame that holds the preview, when it is not the pane's. */
  readonly frame?: string;
  /** A hang cap for a wait that includes a download or an install. */
  readonly timeout?: number;
}

/** Waits until an element of the previewed page has exactly this text. */
export async function expectPreviewText(
  page: Page,
  selector: string,
  text: string,
  wait: PreviewWait = {},
): Promise<void> {
  const settings = { message: `${selector} in the preview`, timeout: wait.timeout };
  await expect.poll(() => previewText(page, selector, wait.frame), settings).toBe(text);
}

/** Clicks an element of the previewed page, as the page's own script would. */
export async function clickInPreview(page: Page, selector: string): Promise<void> {
  const clicked = await inPreview(
    page,
    (query) => {
      const element = document.querySelector<HTMLElement>(query);
      element?.click();
      return element !== null;
    },
    selector,
  );
  expect(clicked, `${selector} in the preview`).toBe(true);
}
