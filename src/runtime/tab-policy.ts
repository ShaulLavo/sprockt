// What a second tab on the same workspace does. Its own module, with no imports, so the
// end-to-end specs can read it and run the tests for the policy that is on.

/**
 * The target is `"attach"`: every tab shares one live filesystem. Waffle 0.0.148 loses file bytes
 * for programs in that mode (an empty `cat`, empty shell redirects; fixed by waffle#630), so until
 * a release with the fix is pinned it is `"takeover"`: a second tab waits for the workspace and
 * asks, and takes it over only when the person confirms. Moving the pin and this line together
 * is the whole switch.
 */
export const TAB_POLICY: "attach" | "takeover" = "takeover";
