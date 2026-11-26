import { describe, expect, test } from "bun:test";
import { fileTabTone, terminalTabTone } from "./tab-colors";

describe("tab colors", () => {
  test("maps file extensions to harmonized tab tones", () => {
    expect(fileTabTone("src/App.tsx")).toBe("ts");
    expect(fileTabTone("vite.config.ts")).toBe("ts");
    expect(fileTabTone("src/App.css")).toBe("css");
    expect(fileTabTone("package.json")).toBe("json");
    expect(fileTabTone("index.html")).toBe("html");
    expect(fileTabTone("src/routes/+page.svelte")).toBe("html");
    expect(fileTabTone("README.md")).toBe("md");
    expect(fileTabTone("LICENSE")).toBe("default");
  });

  test("maps terminal titles and indices to distinct role tones", () => {
    expect(terminalTabTone("bash", 0)).toBe("shell");
    expect(terminalTabTone("dev server", 0)).toBe("server");
    expect(terminalTabTone("bun test", 0)).toBe("task");
    expect(terminalTabTone("bash 2", 1)).toBe("server");
    expect(terminalTabTone("bash 3", 2)).toBe("task");
    expect(terminalTabTone("bash 4", 3)).toBe("aux");
  });
});
