import { describe, expect, test } from "bun:test";
import { isProductionUrl, parseCliArgs, parseViewport, VIEWPORT_PRESETS } from "./args.ts";

describe("agent:browser args", () => {
  test("parses look defaults and doctor flag", () => {
    const parsed = parseCliArgs(["look", "--doctor"]);
    expect(parsed.verb).toBe("look");
    expect(parsed.doctor).toBe(true);
    expect(parsed.viewport).toEqual(VIEWPORT_PRESETS.desktop);
    expect(parsed.scheme).toBe("light");
    expect(parsed.engine).toBe("chromium");
  });

  test("parses phone viewport, dark scheme, webkit engine, and external url", () => {
    const parsed = parseCliArgs([
      "look",
      "--url",
      "https://y78x.shaulavo.dev",
      "--viewport",
      "phone",
      "--scheme",
      "dark",
      "--engine",
      "webkit",
    ]);
    expect(parsed.url).toBe("https://y78x.shaulavo.dev");
    expect(parsed.viewport).toEqual(VIEWPORT_PRESETS.phone);
    expect(parsed.scheme).toBe("dark");
    expect(parsed.engine).toBe("webkit");
  });

  test("parses custom viewport dimensions and marks narrow viewports as mobile touch", () => {
    expect(parseViewport("1280x800")).toEqual({
      label: "1280x800",
      width: 1280,
      height: 800,
      isMobile: false,
      hasTouch: false,
    });
    expect(parseViewport("412x915")).toEqual({
      label: "412x915",
      width: 412,
      height: 915,
      isMobile: true,
      hasTouch: true,
    });
  });

  test("parses scenario verb with starter override", () => {
    const parsed = parseCliArgs(["scenario", "starter-dev-server", "--starter", "vanilla"]);
    expect(parsed.verb).toBe("scenario");
    expect(parsed.scenarioName).toBe("starter-dev-server");
    expect(parsed.starter).toBe("vanilla");
  });

  test("rejects missing scenario name and unknown options", () => {
    expect(() => parseCliArgs(["scenario", "--url", "http://127.0.0.1:4173"])).toThrow(/Missing scenario/);
    expect(() => parseCliArgs(["look", "--bogus"])).toThrow(/Unknown option/);
    expect(() => parseCliArgs(["look", "--engine", "ie6"])).toThrow(/Invalid --engine/);
    expect(() => parseCliArgs(["look", "--scheme", "sepia"])).toThrow(/Invalid --scheme/);
  });

  test("allows --live only for a scenario targeting the production landing page", () => {
    const live = ["--url", "https://sprockt.dev/", "--live"];
    expect(parseCliArgs(["scenario", "starter-dev-server"].concat(live)).live).toBe(true);
    expect(() => parseCliArgs(["look"].concat(live))).toThrow(/--live requires a scenario/);
    expect(() => parseCliArgs(["scenario", "starter-dev-server", "--live"])).toThrow(/--url/);
  });

  test("normalizes trailing dots and subdomains when checking production URLs", () => {
    expect(isProductionUrl("https://sprockt.dev")).toBe(true);
    expect(isProductionUrl("https://sprockt.dev./w/abc")).toBe(true);
    expect(isProductionUrl("https://SUB.SPROCKT.DEV./")).toBe(true);
    expect(isProductionUrl("https://y78x.shaulavo.dev")).toBe(false);
    expect(isProductionUrl("http://127.0.0.1:4173")).toBe(false);
    expect(isProductionUrl("not-a-url")).toBe(false);
  });
});
