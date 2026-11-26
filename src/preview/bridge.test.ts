import { expect, test } from "bun:test";
import { frameCommand, frameMessage, isFrameCommand, isFrameMessage } from "./bridge";
import { askedWorkspace, hostAnnouncement, isHostAnnouncement, isHostQuery } from "./host-protocol";

test("messages built here are recognized as ours", () => {
  expect(isFrameMessage(frameMessage({ type: "started", href: "https://x/" }))).toBe(true);
  expect(isFrameMessage(frameMessage({ type: "location", href: "https://x/", title: "Home" }))).toBe(true);
  expect(isFrameMessage(frameMessage({ type: "error", message: "boom" }))).toBe(true);
  expect(isFrameMessage(frameMessage({ type: "hello", id: 3 }))).toBe(true);
  expect(isFrameCommand(frameCommand({ command: "hello", id: 3 }))).toBe(true);
  expect(isFrameCommand(frameCommand({ command: "reload" }))).toBe(true);
  expect(isFrameCommand(frameCommand({ command: "navigate", href: "https://x/about" }))).toBe(true);
});

test("anything a previewed page could post by itself is not taken for ours", () => {
  for (const foreign of [
    null,
    "reload",
    5,
    {},
    { type: "error", message: "x" },
    { source: "other", type: "error" },
  ]) {
    expect(isFrameMessage(foreign)).toBe(false);
    expect(isFrameCommand(foreign)).toBe(false);
  }
  expect(isFrameMessage({ source: "sprockt-preview", type: "location", href: "https://x/" })).toBe(false);
  expect(isFrameMessage({ source: "sprockt-preview", type: "error", message: 5 })).toBe(false);
  expect(isFrameCommand({ source: "sprockt-preview", command: "navigate" })).toBe(false);
  expect(isFrameMessage({ source: "sprockt-preview", type: "hello", id: "3" })).toBe(false);
  expect(isFrameCommand({ source: "sprockt-preview", command: "hello" })).toBe(false);
  expect(isFrameCommand({ source: "sprockt-preview", command: "close" })).toBe(false);
});

test("a tab's announcement names its workspace", () => {
  expect(isHostAnnouncement(hostAnnouncement("abc"))).toBe(true);
  expect(isHostAnnouncement({ type: "preview-host" })).toBe(false);
  expect(isHostAnnouncement({ type: "preview-request", workspace: "abc" })).toBe(false);
  expect(isHostQuery({ type: "preview-hosts-query" })).toBe(true);
  expect(isHostQuery({ type: "preview-host", workspace: "abc" })).toBe(false);
});

test("a request from the worker is read for the workspace it is tagged with", () => {
  expect(askedWorkspace({ type: "preview-request", port: 3000, workspace: "abc" })).toBe("abc");
  expect(askedWorkspace({ type: "preview-socket-probe", port: 3000, workspace: "abc" })).toBe("abc");
  // Untagged, or not a preview message at all: not a request for any workspace.
  expect(askedWorkspace({ type: "preview-request", port: 3000 })).toBeUndefined();
  expect(askedWorkspace({ type: "something-else", workspace: "abc" })).toBeUndefined();
  expect(askedWorkspace(null)).toBeUndefined();
});
