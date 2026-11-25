import { describe, expect, test } from "bun:test";
import {
  addTab,
  closeTab,
  cycleTab,
  NO_TABS,
  nextTitle,
  renameTab,
  selectTab,
  shellTitle,
  unsplit,
  type TerminalTabs,
} from "./tabs";

const three = (): TerminalTabs => addTab(addTab(addTab(NO_TABS, "a"), "b"), "c");

describe("terminal tabs", () => {
  test("new tabs get the lowest free shell name and take focus", () => {
    const state = three();
    expect(state.tabs.map((tab) => tab.title)).toEqual(["bash", "bash 2", "bash 3"]);
    expect(state.active).toBe("c");
    expect(state.focused).toBe("c");
    expect(nextTitle(closeTab(state, "b"))).toBe("bash 2");
  });

  test("closing the shown tab shows its neighbour, closing the last leaves none", () => {
    let state = selectTab(three(), "b");
    state = closeTab(state, "b");
    expect(state.active).toBe("c");
    state = closeTab(state, "c");
    expect(state.active).toBe("a");
    state = closeTab(state, "a");
    expect(state).toEqual(NO_TABS);
  });

  test("closing a background tab keeps the shown one", () => {
    const state = closeTab(three(), "a");
    expect(state.active).toBe("c");
    expect(state.tabs.map((tab) => tab.id)).toEqual(["b", "c"]);
  });

  test("a split shows two tabs; selecting either only moves focus", () => {
    let state = addTab(addTab(NO_TABS, "a"), "b", undefined, "split");
    expect([state.active, state.split, state.focused]).toEqual(["a", "b", "b"]);
    state = selectTab(state, "a");
    expect([state.active, state.split, state.focused]).toEqual(["a", "b", "a"]);
  });

  test("selecting a third tab ends the split", () => {
    let state = addTab(three(), "d", undefined, "split");
    state = selectTab(state, "a");
    expect([state.active, state.split, state.focused]).toEqual(["a", undefined, "a"]);
  });

  test("closing either half of a split leaves the other half shown", () => {
    const split = addTab(addTab(NO_TABS, "a"), "b", undefined, "split");
    expect(closeTab(split, "b")).toMatchObject({ active: "a", split: undefined, focused: "a" });
    expect(closeTab(split, "a")).toMatchObject({ active: "b", split: undefined, focused: "b" });
  });

  test("unsplitting keeps the focused half on screen", () => {
    const split = addTab(addTab(NO_TABS, "a"), "b", undefined, "split");
    expect(unsplit(split)).toMatchObject({ active: "b", split: undefined, focused: "b" });
    expect(unsplit(selectTab(split, "a"))).toMatchObject({ active: "a", split: undefined });
  });

  test("a rename sticks over shell titles until it is cleared", () => {
    let state = renameTab(three(), "a", "  server  ");
    expect(state.tabs[0]).toMatchObject({ title: "server", named: true });
    state = shellTitle(state, "a", "vim");
    expect(state.tabs[0]?.title).toBe("server");
    state = renameTab(state, "a", "   ");
    state = shellTitle(state, "a", "vim");
    expect(state.tabs[0]).toMatchObject({ title: "vim", named: false });
  });

  test("cycling wraps around", () => {
    const state = three();
    expect(cycleTab(state, 1).focused).toBe("a");
    expect(cycleTab(state, -1).focused).toBe("b");
  });
});
