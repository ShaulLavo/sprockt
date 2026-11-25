// The boot progress list: which steps are done, which one is running and which wait.
import type { BootStage } from "../runtime/boot";
import { ui } from "./copy";

export type StepState = "done" | "active" | "waiting" | "failed";

export interface BootStep {
  readonly stage: Exclude<BootStage, "moved" | "waiting">;
  readonly label: string;
  readonly state: StepState;
}

const STEPS: readonly { readonly stage: BootStep["stage"]; readonly label: string }[] = [
  { stage: "storage", label: ui.boot.openingStorage },
  { stage: "programs", label: ui.boot.startingRuntime },
  { stage: "ready", label: ui.boot.ready },
];

/** The steps for the current stage. A failure marks the running step as failed. */
export function bootSteps(stage: BootStage, failed = false): BootStep[] {
  // Waiting for storage another tab holds is still the storage step.
  const shown = stage === "waiting" ? "storage" : stage;
  const current = STEPS.findIndex((step) => step.stage === shown);
  const reached = current < 0 ? STEPS.length - 1 : current;
  return STEPS.map(({ stage: step, label }, index) => ({
    stage: step,
    label,
    state: stepState(index, reached, step === "ready", failed),
  }));
}

function stepState(index: number, reached: number, last: boolean, failed: boolean): StepState {
  if (index < reached || (index === reached && last)) return "done";
  if (index > reached) return "waiting";
  return failed ? "failed" : "active";
}

/** The label of the step in progress, or of the last one once everything is done. */
export function currentStepLabel(stage: BootStage): string {
  const steps = bootSteps(stage);
  return (steps.find((step) => step.state === "active") ?? steps[steps.length - 1])?.label ?? "";
}
