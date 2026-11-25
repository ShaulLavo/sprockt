import type { Page } from "@playwright/test";
import { editorText, expect, newWorkspace, test } from "./helpers";

// TypeScript IntelliSense end to end: the tsrs language server runs on the workspace's Waffle
// runtime and the editor shows what it answers. Everything is driven the way a person would:
// keyboard shortcuts in the editor, and what the page paints or opens.

const MAIN = `import { Vector, makePoint } from "./shapes";
import { formatMoney, ZERO } from "tiny-money";

const origin = makePoint(0, 0);
const step = new Vector(3, 4);
const label: string = formatMoney(ZERO);
const count: number = "not a number";

export function describe(): string {
  return \`\${label} \${origin.x} \${step.length()} \${count}\`;
}
`;

const PROJECT: Record<string, string> = {
  "tsconfig.json": `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true
  },
  "include": ["src"]
}
`,
  "src/shapes.ts": `export interface Point {
  readonly x: number;
  readonly y: number;
}

export class Vector {
  constructor(
    public x: number,
    public y: number,
  ) {}

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  add(other: Vector): Vector {
    return new Vector(this.x + other.x, this.y + other.y);
  }
}

export function makePoint(x: number, y: number): Point {
  return { x, y };
}
`,
  "node_modules/tiny-money/package.json": `{ "name": "tiny-money", "version": "1.0.0", "types": "index.d.ts" }
`,
  "node_modules/tiny-money/index.d.ts": `export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export declare function formatMoney(value: Money): string;

export declare const ZERO: Money;
`,
  // Written last: the first script file is what starts the server.
  "src/main.ts": MAIN,
};

/** Writes the project through the page's FileService, folders first, in the order given. */
async function writeProject(page: Page, project: Record<string, string> = PROJECT): Promise<void> {
  await page.evaluate(async (files) => {
    const workspace = globalThis.sprockt?.workspace;
    if (!workspace) throw new Error("No workspace on the debug handle");
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split("/").slice(0, -1);
      for (let depth = 1; depth <= parts.length; depth += 1) {
        // oxlint-disable-next-line no-await-in-loop
        await workspace.files.mkdir(parts.slice(0, depth).join("/"));
      }
      // oxlint-disable-next-line no-await-in-loop
      await workspace.files.write(path, text);
    }
  }, project);
}

const isMac = (page: Page) =>
  page.evaluate(() => /mac/i.test(`${navigator.platform} ${navigator.userAgent}`));

/** Presses a key `times` times, one after another as a person would. */
async function pressTimes(page: Page, key: string, times: number): Promise<void> {
  for (let count = 0; count < times; count += 1) {
    // Key presses are sequential by nature.
    // oxlint-disable-next-line no-await-in-loop
    await page.keyboard.press(key);
  }
}

/** Puts the caret at a 1-based line and column with the keyboard. */
async function caretTo(page: Page, line: number, column: number): Promise<void> {
  await page.keyboard.press((await isMac(page)) ? "Meta+ArrowUp" : "Control+Home");
  await pressTimes(page, "ArrowDown", line - 1);
  await page.keyboard.press("Home");
  await pressTimes(page, "ArrowRight", column - 1);
  await expect.poll(() => caret(page)).toMatchObject({ line, column });
}

const caret = (page: Page) => page.evaluate(() => globalThis.sprockt?.editorCaret?.());

/** Text of every error range the language server plugin paints. */
const errorRanges = (page: Page) =>
  page.evaluate(() => {
    const texts: string[] = [];
    for (const [name, highlight] of CSS.highlights) {
      if (!name.includes("lsp-plugin-error")) continue;
      for (const range of highlight) texts.push(range.toString());
    }
    return texts;
  });

const completionLabels = (page: Page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[class*="completion"] [role="option"]'),
      // A row is the kind icon, then the label.
      (row) => (row.children[1] ?? row).textContent ?? "",
    ),
  );

test("TypeScript diagnostics, hover, completion and go-to-definition come from the language server", async ({
  page,
}) => {
  await newWorkspace(page);
  await expect(page.getByTestId("boot-stage")).toHaveText("Ready");
  await writeProject(page);
  const tree = page.getByTestId("file-tree");
  await tree.getByRole("button", { name: "main.ts", exact: true }).click();
  await expect.poll(() => editorText(page)).toBe(MAIN);
  await page.getByTestId("editor").click();
  const mod = (await isMac(page)) ? "Meta" : "Control";

  // A type error is painted under the name it is about.
  await expect.poll(() => errorRanges(page)).toEqual(["count"]);

  // Hover shows the type of `step`.
  await caretTo(page, 5, 8);
  await page.keyboard.press(`${mod}+K`);
  await page.keyboard.press(`${mod}+I`);
  await expect(page.locator('[class*="-hover-body"]').first()).toContainText("const step: Vector");
  await page.keyboard.press("Escape");

  // Completion lists the members of a class from another file.
  await page.keyboard.press((await isMac(page)) ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type("step.");
  await expect
    .poll(() => completionLabels(page))
    .toEqual(expect.arrayContaining(["x", "y", "length", "add"]));
  await page.keyboard.press("Escape");
  await pressTimes(page, "Backspace", "step.".length);
  await expect.poll(() => editorText(page)).toBe(MAIN);

  // Go to definition opens another project file at the declaration.
  await caretTo(page, 5, 19);
  await page.keyboard.press("F12");
  await expect.poll(() => caret(page)).toMatchObject({ path: "src/shapes.ts", line: 6 });

  // And one inside node_modules.
  await page.locator('[data-testid="editor-tab"][data-path="src/main.ts"]').click();
  await expect.poll(() => caret(page)).toMatchObject({ path: "src/main.ts" });
  await page.getByTestId("editor").click();
  await caretTo(page, 6, 25);
  await page.keyboard.press("F12");
  await expect.poll(() => caret(page)).toMatchObject({ path: "node_modules/tiny-money/index.d.ts", line: 6 });
});

test("the server starts when the first TypeScript file arrives inside a moved directory", async ({
  page,
}) => {
  await newWorkspace(page);
  await expect(page.getByTestId("boot-stage")).toHaveText("Ready");
  // Inside node_modules it does not count as the project's own source, so nothing starts yet.
  await writeProject(page, { "node_modules/prepared/main.ts": 'const broken: number = "text";\n' });
  // The move announces only the directory; its file is never named by an event.
  await page.evaluate(() => globalThis.sprockt?.workspace?.files.move("node_modules/prepared", "src"));
  await page.getByTestId("file-tree").getByRole("button", { name: "main.ts", exact: true }).click();
  await expect.poll(() => editorText(page)).toBe('const broken: number = "text";\n');
  await expect.poll(() => errorRanges(page)).toEqual(["broken"]);
});
