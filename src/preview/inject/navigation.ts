// Keeps where a previewed page sends the browser inside its preview: the links it has and the
// forms it submits. The rule for an address is in mounting.ts; this file applies it to the page.
import { framedTarget, remounted, staysInPreview } from "./mounting";
import type { PageServer } from "./tunnel";

// A form exposes its controls as properties of itself, so a control named "action", "target" or
// even "getAttribute" hides the form's own property or method of that name. The functions are
// taken from the prototype, where no control can hide them.
const read = (element: Element, name: string): string | null =>
  Element.prototype.getAttribute.call(element, name);
const write = (element: Element, name: string, value: string): void =>
  Element.prototype.setAttribute.call(element, name, value);

export function keepNavigationMounted(server: PageServer, framed: boolean): void {
  /**
   * Corrects the address in one attribute. Returns whether the browser may follow it: an address
   * that would still land on the IDE's own pages is not followed at all.
   */
  function correctAddress(element: Element, name: string): boolean {
    const page = new URL(location.href);
    const raw = read(element, name) ?? "";
    const mounted = remounted(raw, page, server);
    if (mounted !== undefined) write(element, name, mounted);
    return staysInPreview(mounted ?? raw, page, server);
  }

  /** A frame name that would replace the IDE around the preview becomes the preview's own frame. */
  function correctFrame(element: Element, name: string): void {
    const named = read(element, name);
    const kept = framedTarget(named, framed);
    if (kept !== null && kept !== named) write(element, name, kept);
  }

  /** Makes a form ready to be sent. Returns false when it must not be sent. */
  function prepareForm(form: HTMLFormElement, submitter: HTMLElement | null): boolean {
    // A submit button may name its own address and frame, which then win over the form's.
    const ownAddress = submitter !== null && read(submitter, "formaction") !== null;
    correctFrame(form, "target");
    if (submitter) correctFrame(submitter, "formtarget");
    return ownAddress ? correctAddress(submitter, "formaction") : correctAddress(form, "action");
  }

  // In the capture phase, before the page's own handlers: whatever they do with the address
  // afterwards (read it for a fetch, let the browser submit), it is the mounted one.
  window.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && !prepareForm(form, event.submitter)) event.preventDefault();
    },
    true,
  );

  // `form.submit()` sends the form without a submit event, so it is prepared here.
  const nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function submit(this: HTMLFormElement): void {
    if (prepareForm(this, null)) nativeSubmit.call(this);
  };

  function onLinkClick(event: MouseEvent): void {
    const link = event.target instanceof Element ? event.target.closest("a[href], area[href]") : null;
    if (!link) return;
    correctFrame(link, "target");
    if (!correctAddress(link, "href")) event.preventDefault();
  }
  // A plain click, and a middle click or a modified one that opens a new tab: all of them go
  // to the address the link holds, so that is what is corrected.
  window.addEventListener("click", onLinkClick, true);
  window.addEventListener("auxclick", onLinkClick, true);
}
