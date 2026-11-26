// What a second tab on the same workspace does. Its own module, with no imports, so the
// end-to-end specs can read it and run the tests for the policy that is on.

/**
 * `"attach"`: every tab shares one live filesystem, and when the hosting tab closes another one
 * takes over inside Waffle. `"takeover"` is the fallback: a second tab waits for the workspace and
 * asks, and takes it over only when the person confirms.
 */
export const TAB_POLICY: "attach" | "takeover" = "attach";
