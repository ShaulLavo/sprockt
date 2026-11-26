import { expect, test } from "bun:test";
import { commandsOnly, matchCommands, type PaletteCommand } from "./commands";

const command = (id: string, label: string): PaletteCommand => ({ id, label, run: () => {} });
const COMMANDS = [
  command("save", "Save"),
  command("save-all", "Save all"),
  command("autosave", "Turn off autosave"),
];
const ids = (found: readonly PaletteCommand[]) => found.map((item) => item.id);

test("a query that starts a word of a command finds it", () => {
  expect(ids(matchCommands("sav", COMMANDS))).toEqual(["save", "save-all"]);
  expect(ids(matchCommands("Save a", COMMANDS))).toEqual(["save-all"]);
  expect(ids(matchCommands("auto", COMMANDS))).toEqual(["autosave"]);
});

test("short queries and letters inside a word find no command: they are file names", () => {
  expect(matchCommands("", COMMANDS)).toEqual([]);
  expect(matchCommands("sa", COMMANDS)).toEqual([]);
  expect(matchCommands("ave", COMMANDS)).toEqual([]);
  expect(matchCommands("cntbtn", COMMANDS)).toEqual([]);
});

test("> lists every command, and filters them by what follows", () => {
  expect(commandsOnly(">")).toBe(true);
  expect(commandsOnly(" > save")).toBe(true);
  expect(commandsOnly("save")).toBe(false);
  expect(ids(matchCommands(">", COMMANDS))).toEqual(["save", "save-all", "autosave"]);
  expect(ids(matchCommands("> a", COMMANDS))).toEqual(["save-all", "autosave"]);
});
