import { expect, test } from "bun:test";
import { bootSteps, currentStepLabel } from "./boot-steps";

const states = (stage: Parameters<typeof bootSteps>[0], failed = false) =>
  bootSteps(stage, failed).map((step) => step.state);

test("steps before the current stage are done and later ones wait", () => {
  expect(states("storage")).toEqual(["active", "waiting", "waiting"]);
  expect(states("waiting")).toEqual(["active", "waiting", "waiting"]);
  expect(states("programs")).toEqual(["done", "active", "waiting"]);
  expect(states("ready")).toEqual(["done", "done", "done"]);
});

test("a failure marks the running step", () => {
  expect(states("programs", true)).toEqual(["done", "failed", "waiting"]);
});

test("the current label follows the running step", () => {
  expect(currentStepLabel("storage")).toBe("Opening workspace storage");
  expect(currentStepLabel("ready")).toBe("Ready");
});
