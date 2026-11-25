const JAVASCRIPT = /\.(?:js|mjs|cjs|jsx)$/;

/**
 * Hand-written code here is TypeScript. JavaScript is allowed only under a listed prefix, for
 * generated output or for test inputs that must be JavaScript files.
 */
export function handWrittenJavaScript(
  tracked: readonly string[],
  allowedPrefixes: readonly string[],
): string[] {
  return tracked.filter(
    (file) => JAVASCRIPT.test(file) && !allowedPrefixes.some((prefix) => file.startsWith(prefix)),
  );
}
