// A task's output is what a terminal would be sent. Shown as text in a pane it has to lose the
// parts only a terminal understands.

const ESCAPE = "\u001B";
const BELL = "\u0007";

/**
 * Escape sequences: CSI (colours, cursor moves), OSC (titles, links; ended by a bell or by
 * `ESC \`), and the two-character ones.
 */
const SEQUENCES = new RegExp(
  `${ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)|[@-Z\\\\^_])`,
  "g",
);

/** Terminal output as plain text: no colour or cursor sequences, and plain line ends. */
export function plainOutput(text: string): string {
  return text.replace(SEQUENCES, "").replace(/\r\n?/g, "\n");
}
