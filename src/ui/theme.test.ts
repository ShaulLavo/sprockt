import { expect, test } from "bun:test";
import { parsePreference, preferenceFor, resolveScheme } from "./theme";

test("stored preferences parse, anything else follows the system", () => {
  expect(parsePreference("light")).toBe("light");
  expect(parsePreference("dark")).toBe("dark");
  expect(parsePreference("purple")).toBe("system");
  expect(parsePreference(null)).toBe("system");
});

test("the toggle stores an explicit theme only when it differs from the system", () => {
  expect(preferenceFor("dark", "dark")).toBe("system");
  expect(preferenceFor("light", "dark")).toBe("light");
  expect(resolveScheme("system", "light")).toBe("light");
  expect(resolveScheme("dark", "light")).toBe("dark");
});
