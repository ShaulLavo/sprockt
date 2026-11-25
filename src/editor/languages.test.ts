import { expect, test } from "bun:test";
import { languageOf } from "./languages";

test("known extensions map to their language, whatever the case or directory", () => {
  expect(languageOf("src/main.ts")).toBe("typescript");
  expect(languageOf("src/App.TSX")).toBe("tsx");
  expect(languageOf("a.b/vite.config.mjs")).toBe("javascript");
  expect(languageOf("tsconfig.json")).toBe("json");
});

test("unknown extensions, dotfiles and extensionless names have no language", () => {
  expect(languageOf("notes.xyz")).toBeNull();
  expect(languageOf(".gitignore")).toBeNull();
  expect(languageOf("Makefile")).toBeNull();
  expect(languageOf("dir.ts/README")).toBeNull();
});
