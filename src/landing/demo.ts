// The landing page's one live workspace demo. Every workbench render on the page shares this
// state, just as two browser tabs share one workspace: typing, install output, dev server boot,
// TypeScript hover, save tick, HMR flash and the interactive counter stay in sync.
import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { DEMO_SEQUENCE } from "../ui/motion";

/** Step indices for the scripted workbench sequence. */
export const DEMO_INSTALL_TYPING = 1;
export const DEMO_INSTALL_DONE = 2;
export const DEMO_DEV_TYPING = 3;
export const DEMO_READY = 4;
export const DEMO_HOVER_EDIT = 5;
export const DEMO_SAVED_HMR = 6;

export type DemoFileId = "App.tsx" | "App.css" | "package.json" | "index.html";
export type DemoTerminalId = "bash" | "dev";

const INSTALL_CMD = "bun install";
const DEV_CMD = "bun run dev";

export interface Demo {
  /** 0..DEMO_SAVED_HMR */
  readonly step: Accessor<number>;
  readonly ready: Accessor<boolean>;
  readonly installTyped: Accessor<string>;
  readonly devTyped: Accessor<string>;
  /** Status bar save state: "idle" | "saving" | "saved". */
  readonly saveState: Accessor<"idle" | "saving" | "saved">;
  /** Brief visual pulse on the preview card when HMR updates. */
  readonly hmrFlash: Accessor<boolean>;
  /** Active editor tab (interactive: visitors can click any multicolor tab). */
  readonly activeFile: Accessor<DemoFileId>;
  setActiveFile(file: DemoFileId): void;
  /** Active terminal tab (interactive: bash vs dev server). */
  readonly activeTerm: Accessor<DemoTerminalId>;
  setActiveTerm(tab: DemoTerminalId): void;
  /** Interactive counter inside the Vite + React preview. */
  readonly count: Accessor<number>;
  bump(): void;
  /** Pause or replay the scripted sequence. */
  readonly playing: Accessor<boolean>;
  replay(): void;
  pause(): void;
}

/**
 * Runs the scripted workbench sequence once on mount, with replay and pause controls.
 * Visitors with `prefers-reduced-motion: reduce` see the calm finished state immediately.
 */
export function createDemo(): Demo {
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const [step, setStep] = createSignal(reduced ? DEMO_SAVED_HMR : 0);
  const [installTyped, setInstallTyped] = createSignal(reduced ? INSTALL_CMD : "");
  const [devTyped, setDevTyped] = createSignal(reduced ? DEV_CMD : "");
  const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved">("saved");
  const [hmrFlash, setHmrFlash] = createSignal(false);
  const [activeFile, setActiveFile] = createSignal<DemoFileId>("App.tsx");
  const [activeTerm, setActiveTerm] = createSignal<DemoTerminalId>("bash");
  const [count, setCount] = createSignal(0);
  const [playing, setPlaying] = createSignal(!reduced);

  const timers: ReturnType<typeof setTimeout>[] = [];

  function clearTimers(): void {
    while (timers.length > 0) {
      const id = timers.pop();
      if (id !== undefined) clearTimeout(id);
    }
  }

  function at(delayMs: number, fn: () => void): void {
    timers.push(setTimeout(fn, delayMs));
  }

  function typeCommand(startMs: number, text: string, write: (value: string) => void): void {
    for (let i = 1; i <= text.length; i += 1) {
      const slice = text.slice(0, i);
      at(startMs + i * DEMO_SEQUENCE.typeCharMs, () => write(slice));
    }
  }

  function runSequence(): void {
    clearTimers();
    setPlaying(true);
    setStep(0);
    setInstallTyped("");
    setDevTyped("");
    setSaveState("idle");
    setHmrFlash(false);
    setActiveFile("App.tsx");
    setActiveTerm("bash");

    at(DEMO_SEQUENCE.installStartMs, () => setStep(DEMO_INSTALL_TYPING));
    typeCommand(DEMO_SEQUENCE.installStartMs, INSTALL_CMD, setInstallTyped);

    at(DEMO_SEQUENCE.installOutputMs, () => {
      setInstallTyped(INSTALL_CMD);
      setStep(DEMO_INSTALL_DONE);
    });

    at(DEMO_SEQUENCE.devStartMs, () => setStep(DEMO_DEV_TYPING));
    typeCommand(DEMO_SEQUENCE.devStartMs, DEV_CMD, setDevTyped);

    at(DEMO_SEQUENCE.devReadyMs, () => {
      setDevTyped(DEV_CMD);
      setStep(DEMO_READY);
      setSaveState("saved");
    });

    at(DEMO_SEQUENCE.editHighlightMs, () => {
      setStep(DEMO_HOVER_EDIT);
      setSaveState("saving");
    });

    at(DEMO_SEQUENCE.saveTickMs, () => {
      setSaveState("saved");
      setStep(DEMO_SAVED_HMR);
    });

    at(DEMO_SEQUENCE.hmrFlashMs, () => {
      setHmrFlash(true);
      at(DEMO_SEQUENCE.hmrDurationMs, () => {
        setHmrFlash(false);
        setPlaying(false);
      });
    });
  }

  function pause(): void {
    clearTimers();
    setInstallTyped(INSTALL_CMD);
    setDevTyped(DEV_CMD);
    setStep(DEMO_SAVED_HMR);
    setSaveState("saved");
    setHmrFlash(false);
    setPlaying(false);
  }

  onMount(() => {
    if (!reduced) runSequence();
    onCleanup(clearTimers);
  });

  return {
    step,
    ready: () => step() >= DEMO_READY,
    installTyped,
    devTyped,
    saveState,
    hmrFlash,
    activeFile,
    setActiveFile,
    activeTerm,
    setActiveTerm,
    count,
    bump: () => setCount((value) => value + 1),
    playing,
    replay: () => {
      if (reduced) {
        pause();
        return;
      }
      runSequence();
    },
    pause,
  };
}
