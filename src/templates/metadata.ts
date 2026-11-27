// Lightweight starter template metadata for the landing grid (no template source files).

export type TemplateId =
  | "vite-react"
  | "next-app"
  | "hono"
  | "astro"
  | "sveltekit"
  | "vanilla"
  | "bun-sqlite"
  | "blank";

export interface TemplateSummary {
  readonly id: TemplateId;
  readonly label: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly defaultName: string;
  readonly editorFile?: string;
  readonly featured?: boolean;
}

export const STARTER_TEMPLATE_SUMMARIES: readonly TemplateSummary[] = [
  {
    id: "vite-react",
    label: "Vite + React",
    description: "React 19 and TypeScript on Vite",
    longDescription: "React 19 and TypeScript on Vite with HMR. Preview opens on port 5173.",
    defaultName: "vite-react",
    editorFile: "src/App.tsx",
    featured: true,
  },
  {
    id: "next-app",
    label: "Next.js",
    description: "App Router with React 19",
    defaultName: "next-app",
    editorFile: "app/page.tsx",
  },
  {
    id: "hono",
    label: "Hono",
    description: "HTTP routes on Bun.serve",
    defaultName: "hono-app",
    editorFile: "server.ts",
  },
  {
    id: "astro",
    label: "Astro",
    description: "Content and server pages",
    defaultName: "astro-app",
    editorFile: "src/pages/index.astro",
  },
  {
    id: "sveltekit",
    label: "SvelteKit",
    description: "Svelte 5 with file routing",
    defaultName: "sveltekit-app",
    editorFile: "src/routes/+page.svelte",
  },
  {
    id: "vanilla",
    label: "Vanilla TS",
    description: "Plain TypeScript on Vite",
    defaultName: "vanilla-ts",
    editorFile: "src/main.ts",
  },
  {
    id: "bun-sqlite",
    label: "Bun.serve + SQLite",
    description: "SQLite API, zero deps",
    defaultName: "sqlite-notes",
    editorFile: "server.ts",
  },
];

export const BLANK_TEMPLATE_SUMMARY: TemplateSummary = {
  id: "blank",
  label: "Blank",
  description: "Empty folder with a bash shell",
  defaultName: "workspace",
};

const ALL_SUMMARIES: readonly TemplateSummary[] = STARTER_TEMPLATE_SUMMARIES.concat([BLANK_TEMPLATE_SUMMARY]);

export function templateLabel(id: string): string {
  if (id === "github") return "GitHub";
  return ALL_SUMMARIES.find((template) => template.id === id)?.label ?? "Workspace";
}

export function templateDefaultName(id: string): string | undefined {
  return ALL_SUMMARIES.find((template) => template.id === id)?.defaultName;
}
