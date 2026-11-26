import { expect, test } from "bun:test";
import { languageName, languageOf } from "./languages";

test("known extensions map to their language, whatever the case or directory", () => {
  expect(languageOf("src/main.ts")).toBe("typescript");
  expect(languageOf("src/App.TSX")).toBe("tsx");
  expect(languageOf("a.b/vite.config.mjs")).toBe("javascript");
  expect(languageOf("tsconfig.json")).toBe("json");
  expect(languageOf("src/App.vue")).toBe("html");
  expect(languageOf("src/pages/index.astro")).toBe("astro");
});

test("unknown extensions, dotfiles and extensionless names have no language", () => {
  expect(languageOf("notes.xyz")).toBeNull();
  expect(languageOf(".gitignore")).toBeNull();
  expect(languageOf("Makefile")).toBeNull();
  expect(languageOf("dir.ts/README")).toBeNull();
});

test("the status bar names a file's language, and plain text otherwise", () => {
  expect(languageName("src/App.tsx")).toBe("TypeScript JSX");
  expect(languageName("src/App.vue")).toBe("Vue");
  expect(languageName("README.MD")).toBe("Markdown");
  expect(languageName("Makefile")).toBe("Plain Text");
  expect(languageName(".env")).toBe("Plain Text");
});
