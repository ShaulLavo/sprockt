// The source the landing page's workbench demo shows: src/App.tsx of the Vite + React starter,
// word for word (starter-source.test.ts holds it to src/templates/catalog.ts), plus companion
// files for the interactive multicolor tabs. Kept apart from catalog.ts so `/` loads no templates.

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

const APP_CSS_SOURCE = `.app {
  max-width: 460px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

.counter {
  margin: 1rem 0;
  padding: 0.65rem 1.25rem;
  border-radius: 999px;
  background: #1a4be0;
  color: #ffffff;
  font-weight: 500;
}
`;

const PACKAGE_JSON_SOURCE = `{
  "name": "react-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1 --port 5173 --strictPort",
    "build": "vite build"
  },
  "dependencies": {
    "react": "19.3.1",
    "react-dom": "19.3.1"
  },
  "devDependencies": {
    "vite": "8.3.5"
  }
}
`;

const INDEX_HTML_SOURCE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>React app</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
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
  /("(?:[^"\\]|\\.)*")|\b(import|from|function|const|return|export|default)\b|(?<=<\/?)([A-Za-z][\w]*)|\b(className|onClick|lang|charset|name|content|id|type|src)(?==)|\b(\d+(?:\.\d+)?(?:px|rem|%)?)\b|\b([A-Za-z_]\w*)(?=\()|([{}()[\];,=<>/+:]+)/g;

const TOKEN_KINDS = ["ss", "sk", "stg", "sa", "sn", "sf", "sp"] as const;

function kindOf(match: RegExpExecArray): string {
  const index = TOKEN_KINDS.findIndex((_, group) => match[group + 1] !== undefined);
  return TOKEN_KINDS[index] ?? "";
}

/** Splits one line of source into syntax runs for display. */
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

export const DEMO_FILE_LINES = {
  "App.tsx": APP_TSX_LINES,
  "App.css": APP_CSS_SOURCE.trimEnd().split("\n").map(markLine),
  "package.json": PACKAGE_JSON_SOURCE.trimEnd().split("\n").map(markLine),
  "index.html": INDEX_HTML_SOURCE.trimEnd().split("\n").map(markLine),
} as const;
