// The source the landing page's workbench render shows: src/App.tsx of the Vite + React starter,
// word for word (starter-source.test.ts holds it to src/templates/catalog.ts), and a small
// marker for its syntax. Kept apart from the catalog so the landing page loads no templates.

export const APP_TSX_SOURCE = `import { useState } from "react";
import "./App.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <main className="app">
      <h1>Hello from bun.wasm</h1>
      <p className="tagline">
        Vite serves this React app through Bun, running in your browser.
      </p>
      <button className="counter" onClick={() => setCount((n) => n + 1)}>
        count is {count}
      </button>
      <p className="hint">
        Edit <code>src/App.tsx</code> and the page updates without losing
        the count.
      </p>
    </main>
  );
}

export default App;
`;

/** A run of text and the syntax class it is drawn in; "" is plain text. */
export type Token = readonly [kind: string, text: string];

export interface SourceLine {
  /** Leading spaces, in columns. A wrapped line continues at this indent. */
  readonly indent: number;
  readonly tokens: readonly Token[];
}

// One alternative per kind, in the order of TOKEN_KINDS below.
const TOKEN =
  /("(?:[^"\\]|\\.)*")|\b(import|from|function|const|return|export|default)\b|(?<=<\/?)([A-Za-z][\w]*)|\b(className|onClick)(?==)|\b(\d+)\b|\b([A-Za-z_]\w*)(?=\()|([{}()[\];,=<>/+]+)/g;

const TOKEN_KINDS = ["ss", "sk", "stg", "sa", "sn", "sf", "sp"] as const;

function kindOf(match: RegExpExecArray): string {
  const index = TOKEN_KINDS.findIndex((_, group) => match[group + 1] !== undefined);
  return TOKEN_KINDS[index] ?? "";
}

/** Splits one line of the starter's TSX into runs for display. Not a parser: it knows this file. */
export function markLine(line: string): SourceLine {
  const text = line.trimStart();
  const tokens: Token[] = [];
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > at) tokens.push(["", text.slice(at, match.index)]);
    tokens.push([kindOf(match), match[0]]);
    at = match.index + match[0].length;
  }
  if (at < text.length) tokens.push(["", text.slice(at)]);
  return { indent: line.length - text.length, tokens };
}

/** The starter's App.tsx as display lines, without the file's final newline. */
export const APP_TSX_LINES: readonly SourceLine[] = APP_TSX_SOURCE.trimEnd().split("\n").map(markLine);
