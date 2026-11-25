// Starter template catalog and file sets ported from bun-wasm/sandbox/template-*.
// Pure data and lookup helpers: no Solid, no DOM, no Waffle imports.
import {
  BLANK_TEMPLATE_SUMMARY,
  STARTER_TEMPLATE_SUMMARIES,
  templateLabel,
  type TemplateId,
  type TemplateSummary,
} from "./metadata";

export { templateLabel, type TemplateId, type TemplateSummary };

export interface StarterTemplate extends TemplateSummary {
  readonly files: Readonly<Record<string, string>>;
}

const VITE_REACT_FILES: Readonly<Record<string, string>> = {
  "index.html": `<!doctype html>
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
`,
  "package.json": `{
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
    "vite": "8.3.5",
    "@vitejs/plugin-react": "6.1.2"
  }
}
`,
  "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({ plugins: [react()] });
`,
  "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  "src/App.tsx": `import { useState } from "react";
import "./App.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <main className="app">
      <h1>Hello from bun.wasm</h1>
      <p className="tagline">Vite serves this React app through Bun, running in your browser.</p>
      <button className="counter" onClick={() => setCount((n) => n + 1)}>
        count is {count}
      </button>
      <p className="hint">
        Edit <code>src/App.tsx</code> and the page updates without losing the count.
      </p>
    </main>
  );
}

export default App;
`,
  "src/App.css": `:root {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #f3f1ea;
  background: #1b1c22;
}

body {
  margin: 0;
}

.app {
  min-height: 100vh;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 0.75rem;
  padding: 2rem;
  text-align: center;
}

h1 {
  margin: 0;
  font-size: 2.2rem;
  color: #fbf0df;
}

.tagline {
  margin: 0;
  color: #b7b4ad;
}

.counter {
  margin-top: 1rem;
  padding: 0.7rem 1.4rem;
  font: inherit;
  font-weight: 600;
  color: #1b1c22;
  background: #fbf0df;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}

.counter:active {
  transform: scale(0.97);
}

.hint {
  color: #8d8a84;
  font-size: 0.9rem;
}

code {
  color: #f472b6;
}
`,
};

const NEXT_APP_FILES: Readonly<Record<string, string>> = {
  "package.json": `{
  "name": "next-app-router",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "NEXT_TELEMETRY_DISABLED=1 next dev --hostname 127.0.0.1 --port 5173",
    "build": "next build",
    "start": "NEXT_TELEMETRY_DISABLED=1 next start --hostname 127.0.0.1 --port 5173"
  },
  "dependencies": {
    "@next/swc-wasm-nodejs": "15.5.6",
    "next": "15.5.6",
    "react": "19.1.1",
    "react-dom": "19.1.1"
  },
  "devDependencies": {
    "@types/node": "22.18.11",
    "@types/react": "19.1.16",
    "typescript": "5.9.3"
  }
}
`,
  "next.config.ts": `import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: { cpus: 1 },
};

export default config;
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
`,
  "app/layout.tsx": `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "app/page.tsx": `"use client";

import { useEffect, useState } from "react";

export default function Home() {
  return (
    <main>
      <h1>Next.js App Router</h1>
      <p>Edit app/page.tsx. Next dev updates this preview when you save.</p>
      <Counter />
    </main>
  );
}

function Counter() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  return <button disabled={!hydrated} onClick={() => setCount(value => value + 1)}>Count: {count}</button>;
}
`,
};

const HONO_FILES: Readonly<Record<string, string>> = {
  "package.json": `{
  "name": "hono-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --hot run server.ts",
    "build": "bun build server.ts --target=bun --outdir=dist",
    "start": "bun run dist/server.js"
  },
  "dependencies": {
    "hono": "4.10.2"
  }
}
`,
  "server.ts": `import { Hono } from "hono";
import page from "./src/page.html" with { type: "text" };

const client = await Bun.build({ entrypoints: ["counter.ts"], target: "browser" });
if (!client.success || !client.outputs[0]) throw new Error("Counter build failed");
const app = new Hono();
app.get("/counter.ts", () => new Response(client.outputs[0], { headers: { "content-type": "text/javascript" } }));
app.get("/", (c) => c.html(page));
Bun.serve({ hostname: "127.0.0.1", port: 5173, fetch: app.fetch });
`,
  "counter.ts": `const button = document.querySelector<HTMLButtonElement>("#increment");
const count = document.querySelector<HTMLOutputElement>("#count");
if (!button || !count) throw new Error("Counter elements missing");
button.addEventListener("click", () => { count.value = String(Number(count.value) + 1); });
button.disabled = false;
`,
  "src/page.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hono</title>
  </head>
  <body>
    <h1 id="message">Hello from hono</h1>
    <button id="increment" type="button" disabled>Increment</button>
    <output id="count">0</output>
    <script type="module" src="/counter.ts"></script>
  </body>
</html>
`,
};

const ASTRO_FILES: Readonly<Record<string, string>> = {
  "package.json": `{
  "name": "astro-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run node_modules/astro/astro.js dev --host 127.0.0.1 --port 5173",
    "build": "bun run node_modules/astro/astro.js build",
    "start": "bun run start.ts 5173"
  },
  "dependencies": {
    "astro": "5.14.1",
    "@astrojs/node": "9.4.4",
    "typescript": "5.9.3"
  }
}
`,
  "astro.config.ts": `import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  devToolbar: { enabled: false },
});
`,
  "src/pages/index.astro": `---
const value = Astro.url.searchParams.get("value") ?? "initial";
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Astro app</title>
  </head>
  <body>
    <h1 id="message">Hello from astro</h1>
    <p id="server-value">{value}</p>
    <button id="increment" disabled>Increment</button>
    <output id="count">0</output>
    <script>
      const button = document.querySelector<HTMLButtonElement>("#increment");
      const output = document.querySelector<HTMLOutputElement>("#count");
      if (!button || !output) throw new Error("Counter elements missing");
      let count = 0;
      button.addEventListener("click", () => { output.textContent = String(++count); });
      button.disabled = false;
    </script>
  </body>
</html>
`,
  "start.ts": `const port = process.argv[2];
if (!port) throw new Error("Expected a port");
process.env.NODE_ENV = "production";
process.env.HOST = "127.0.0.1";
process.env.PORT = port;
process.env.NITRO_HOST = "127.0.0.1";
process.env.NITRO_PORT = port;
await import("./dist/server/entry.mjs");
`,
};

const SVELTEKIT_FILES: Readonly<Record<string, string>> = {
  "package.json": `{
  "name": "sveltekit-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort",
    "build": "bun run node_modules/vite/bin/vite.js build",
    "start": "bun run start.ts 5173"
  },
  "dependencies": {
    "@sveltejs/kit": "2.43.1",
    "@sveltejs/adapter-node": "5.3.2",
    "@sveltejs/vite-plugin-svelte": "6.2.1",
    "@opentelemetry/api": "1.9.0",
    "svelte": "5.39.11",
    "vite": "7.1.12",
    "typescript": "5.9.3"
  }
}
`,
  "svelte.config.ts": `import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default { preprocess: vitePreprocess(), kit: { adapter: adapter({ out: "build" }) } };
`,
  "vite.config.ts": `import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

export default defineConfig({ plugins: [sveltekit()] });
`,
  "src/app.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    %sveltekit.head%
  </head>
  <body>
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`,
  "src/routes/+page.server.ts": `export function load({ url }: { url: URL }) {
  return { value: url.searchParams.get("value") ?? "initial" };
}
`,
  "src/routes/+page.svelte": `<script lang="ts">
  import { onMount } from "svelte";
  let hydrated = $state(false);
  onMount(() => { hydrated = true; });
  let { data } = $props();
  let count = $state(0);
</script>
<h1 id="message" data-hydrated={hydrated}>Hello from sveltekit</h1>
<p id="server-value">{data.value}</p>
<button id="increment" disabled={!hydrated} onclick={() => count++}>Increment</button>
<output id="count">{count}</output>
`,
  "start.ts": `const port = process.argv[2];
if (!port) throw new Error("Expected a port");
process.env.NODE_ENV = "production";
process.env.HOST = "127.0.0.1";
process.env.PORT = port;
process.env.NITRO_HOST = "127.0.0.1";
process.env.NITRO_PORT = port;
await import("./build/index.js");
`,
};

const VANILLA_FILES: Readonly<Record<string, string>> = {
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vanilla TypeScript app</title>
  </head>
  <body>
    <main class="app" id="root"></main>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
`,
  "package.json": `{
  "name": "vanilla-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1 --port 5173 --strictPort",
    "build": "vite build"
  },
  "devDependencies": {
    "vite": "8.3.5"
  }
}
`,
  "src/main.ts": `import "./App.css";

const root = document.querySelector<HTMLElement>("#root")!;
let count = import.meta.hot ? import.meta.hot.data.count ?? 0 : 0;
root.innerHTML = \`
  <h1>Hello from vanilla TypeScript</h1>
  <p class="tagline">Vite hot reload works without a framework.</p>
  <button class="counter">count is \${count}</button>
  <p class="hint">Edit src/main.ts. The count lives in import.meta.hot.data.</p>
\`;
const button = root.querySelector<HTMLButtonElement>("button")!;
button.onclick = () => { button.textContent = \`count is \${++count}\`; };

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose((data) => { data.count = count; });
}
`,
  "src/App.css": `:root {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #f3f1ea;
  background: #1b1c22;
}

body {
  margin: 0;
}

.app {
  min-height: 100vh;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 0.75rem;
  padding: 2rem;
  text-align: center;
}

h1 {
  margin: 0;
  font-size: 2.2rem;
  color: #fbf0df;
}

.tagline {
  margin: 0;
  color: #b7b4ad;
}

.counter {
  margin-top: 1rem;
  padding: 0.7rem 1.4rem;
  font: inherit;
  font-weight: 600;
  color: #1b1c22;
  background: #fbf0df;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}

.counter:active {
  transform: scale(0.97);
}

.hint {
  color: #8d8a84;
  font-size: 0.9rem;
}

code {
  color: #f472b6;
}
`,
};

const BUN_SQLITE_FILES: Readonly<Record<string, string>> = {
  "package.json": `{
  "name": "bun-sqlite-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --hot run server.ts",
    "start": "bun run server.ts",
    "test": "bun test"
  }
}
`,
  "server.ts": `import { Database } from "bun:sqlite";

const db = new Database("notes.sqlite", { create: true });
db.run(\`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
\`);

const countRow = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM notes").get();
if ((countRow?.count ?? 0) === 0) {
  const insert = db.query("INSERT INTO notes (body) VALUES (?)");
  insert.run("Bun.serve runs in WebAssembly");
  insert.run("SQLite persists inside IndexedDB");
}

function listNotes() {
  return db.query<{ id: number; body: string; created_at: string }, []>(
    "SELECT id, body, created_at FROM notes ORDER BY id DESC",
  ).all();
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderPage(): string {
  const rows = listNotes()
    .map((note) => \`<li><span>\${escapeHtml(note.body)}</span><small>#\${note.id}</small></li>\`)
    .join("");
  return \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bun.serve + bun:sqlite</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 520px; margin: 48px auto; padding: 0 16px; background: #0d1117; color: #e6ebf2; }
      form { display: flex; gap: 8px; margin: 16px 0 24px; }
      input { flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid #303c4c; background: #1a2230; color: inherit; font: inherit; }
      button { padding: 10px 16px; border-radius: 8px; border: 0; background: #d92a62; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
      ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
      li { display: flex; justify-content: space-between; padding: 10px 12px; border: 1px solid #222c39; border-radius: 8px; background: #121821; }
      small { color: #7f8b9c; font-family: ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <h1>Bun.serve + bun:sqlite</h1>
    <form method="POST" action="/notes">
      <input name="body" placeholder="Write a note..." required />
      <button type="submit">Add</button>
    </form>
    <ul>\${rows}</ul>
  </body>
</html>\`;
}

Bun.serve({
  hostname: "127.0.0.1",
  port: 5173,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/notes" && request.method === "GET") {
      return Response.json(listNotes());
    }
    if (url.pathname === "/notes" && request.method === "POST") {
      const form = await request.formData();
      const body = String(form.get("body") ?? "").trim();
      if (body) db.query("INSERT INTO notes (body) VALUES (?)").run(body);
      return Response.redirect("/", 303);
    }
    return new Response(renderPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
`,
  "server.test.ts": `import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("stores and reads rows in bun:sqlite", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
  db.query("INSERT INTO notes (body) VALUES (?)").run("hello sqlite");
  const row = db.query<{ body: string }, []>("SELECT body FROM notes").get();
  expect(row?.body).toBe("hello sqlite");
  db.close();
});
`,
};

const TEMPLATE_FILES: Readonly<Record<TemplateId, Readonly<Record<string, string>>>> = {
  "vite-react": VITE_REACT_FILES,
  "next-app": NEXT_APP_FILES,
  hono: HONO_FILES,
  astro: ASTRO_FILES,
  sveltekit: SVELTEKIT_FILES,
  vanilla: VANILLA_FILES,
  "bun-sqlite": BUN_SQLITE_FILES,
  blank: {},
};

function withFiles(summary: TemplateSummary): StarterTemplate {
  return { ...summary, files: TEMPLATE_FILES[summary.id] };
}

export const STARTER_TEMPLATES: readonly StarterTemplate[] = STARTER_TEMPLATE_SUMMARIES.map(withFiles);

export const BLANK_TEMPLATE: StarterTemplate = withFiles(BLANK_TEMPLATE_SUMMARY);

export const ALL_TEMPLATES: readonly StarterTemplate[] = STARTER_TEMPLATES.concat([BLANK_TEMPLATE]);

export function findTemplate(id: string): StarterTemplate | undefined {
  return ALL_TEMPLATES.find((template) => template.id === id);
}
