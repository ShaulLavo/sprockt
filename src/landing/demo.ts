// The landing page's one workspace. Every workbench render on the page reads this same state,
// the way two tabs share one workspace: the boot plays once and the counter is the same in each.
import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";

/** Boot steps, in order: an idle prompt, the install typed, its output, dev typed, ready. */
export const DEMO_READY = 4;

/** When each step after the first begins, in milliseconds from page load. */
const STEP_AT_MS = [700, 1250, 1900, 2450] as const;

export interface Demo {
  /** 0 to DEMO_READY. */
  readonly step: Accessor<number>;
  readonly ready: Accessor<boolean>;
  /** The preview app's counter. */
  readonly count: Accessor<number>;
  bump(): void;
}

let played = false;

/**
 * Plays the boot once per page load. Coming back to the landing page, and visitors who ask for
 * reduced motion, see the finished state at once. Call inside a component.
 */
export function createDemo(): Demo {
  const still = played || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [step, setStep] = createSignal(still ? DEMO_READY : 0);
  const [count, setCount] = createSignal(0);

  onMount(() => {
    if (still) return;
    played = true;
    const timers = STEP_AT_MS.map((at, index) => setTimeout(() => setStep(index + 1), at));
    onCleanup(() => {
      for (const timer of timers) clearTimeout(timer);
    });
  });

  return {
    step,
    ready: () => step() >= DEMO_READY,
    count,
    bump: () => setCount((value) => value + 1),
  };
}
