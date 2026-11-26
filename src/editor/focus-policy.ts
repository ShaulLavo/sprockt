// Focus rules for opening and switching files: desktop mouse and explicit keyboard interactions
// focus the editor immediately, while touch/mobile navigation keeps the soft keyboard closed until
// the user explicitly taps the editor text surface.

export type MediaMatcher = (query: string) => { readonly matches: boolean };

/** True for touch pointers, coarse-pointer devices, or phone-width viewports. */
export function isTouchOrMobile(
  pointerType?: string,
  match: MediaMatcher | undefined = typeof matchMedia === "function" ? matchMedia : undefined,
): boolean {
  if (pointerType === "touch") return true;
  if (!match) return false;
  return match("(pointer: coarse)").matches || match("(max-width: 768px)").matches;
}

/** Whether switching or revealing a file should automatically move keyboard focus into the editor. */
export function shouldAutoFocusEditor(pointerType?: string, match?: MediaMatcher): boolean {
  if (pointerType === "keyboard") return true;
  return !isTouchOrMobile(pointerType, match);
}
