// The landing page's one live workspace demo. Every workbench render on the page shares this
// state, just as two browser tabs share one workspace: typing, install output, dev server boot,
// TypeScript hover, save tick, HMR flash and the interactive counter stay in sync.
import { createSignal, onCleanup, onMount, type Accessor } from "../lib/reactive";
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
  /** Whether the scripted sequence is currently running (drives blinking cursors too). */
  readonly playing: Accessor<boolean>;
  /** True while `prefers-reduced-motion: reduce` is active (Replay is unavailable). */
  readonly reducedMotion: Accessor<boolean>;
  replay(): void;
  pause(): void;
}

export interface DemoEnvironment {
  isHidden(): boolean;
  isReduced(): boolean;
  subscribeVisibility(listener: () => void): () => void;
  subscribeReduced(listener: (reduced: boolean) => void): () => void;
  schedule(delayMs: number, fn: () => void): () => void;
}

export interface DemoController extends Demo {
  start(): void;
  dispose(): void;
}

function browserDemoEnvironment(): DemoEnvironment {
  const reducedQuery =
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;

  return {
    isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    isReduced: () => reducedQuery?.matches ?? false,
    subscribeVisibility(listener) {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    subscribeReduced(listener) {
      if (!reducedQuery) return () => {};
      const handler = () => listener(reducedQuery.matches);
      reducedQuery.addEventListener("change", handler);
      return () => reducedQuery.removeEventListener("change", handler);
    },
    schedule(delayMs, fn) {
      const id = setTimeout(fn, delayMs);
      return () => clearTimeout(id);
    },
  };
}

/**
 * Pure reactive controller for the scripted workbench sequence.
 * Skips starting when mounted hidden, cancels pending timers when the tab hides or reduced motion
 * turns on, resumes cleanly when visible again (unless paused or already finished), and exposes
 * `playing()` so cursor blinking stops on Pause and at playback end.
 */
export function createDemoController(env: DemoEnvironment = browserDemoEnvironment()): DemoController {
  const initialReduced = env.isReduced();

  const [reducedMotion, setReducedMotion] = createSignal(initialReduced);
  const [step, setStep] = createSignal(initialReduced ? DEMO_SAVED_HMR : 0);
  const [installTyped, setInstallTyped] = createSignal(initialReduced ? INSTALL_CMD : "");
  const [devTyped, setDevTyped] = createSignal(initialReduced ? DEV_CMD : "");
  const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved">("saved");
  const [hmrFlash, setHmrFlash] = createSignal(false);
  const [activeFile, setActiveFile] = createSignal<DemoFileId>("App.tsx");
  const [activeTerm, setActiveTerm] = createSignal<DemoTerminalId>("bash");
  const [count, setCount] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);

  const cancelFns: (() => void)[] = [];
  const subscriptions: (() => void)[] = [];
  let resumeOnVisible = false;
  let disposed = false;

  function clearTimers(): void {
    while (cancelFns.length > 0) {
      const cancel = cancelFns.pop();
      cancel?.();
    }
  }

  function at(delayMs: number, fn: () => void): void {
    let cancel: (() => void) | undefined;
    cancel = env.schedule(delayMs, () => {
      if (cancel) {
        const index = cancelFns.indexOf(cancel);
        if (index >= 0) cancelFns.splice(index, 1);
      }
      if (!disposed) fn();
    });
    cancelFns.push(cancel);
  }

  function typeCommand(startMs: number, text: string, write: (value: string) => void): void {
    for (let i = 1; i <= text.length; i += 1) {
      const slice = text.slice(0, i);
      at(startMs + i * DEMO_SEQUENCE.typeCharMs, () => write(slice));
    }
  }

  function settleCalm(): void {
    clearTimers();
    resumeOnVisible = false;
    setInstallTyped(INSTALL_CMD);
    setDevTyped(DEV_CMD);
    setStep(DEMO_SAVED_HMR);
    setSaveState("saved");
    setHmrFlash(false);
    setPlaying(false);
  }

  function runSequence(): void {
    clearTimers();
    if (disposed || reducedMotion()) {
      settleCalm();
      return;
    }
    if (env.isHidden()) {
      setHmrFlash(false);
      setPlaying(false);
      resumeOnVisible = true;
      return;
    }
    resumeOnVisible = false;
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
    settleCalm();
  }

  function replay(): void {
    if (reducedMotion()) {
      settleCalm();
      return;
    }
    runSequence();
  }

  function handleVisibilityChange(): void {
    if (disposed) return;
    if (env.isHidden()) {
      // Hidden mid-playback: settle on the finished scene rather than restart it later, so
      // coming back keeps the chosen file and terminal tab and the ready preview.
      if (playing()) settleCalm();
      return;
    }
    if (resumeOnVisible && !reducedMotion()) {
      resumeOnVisible = false;
      runSequence();
    }
  }

  function handleReducedChange(next: boolean): void {
    if (disposed) return;
    setReducedMotion(next);
    if (next) settleCalm();
  }

  function start(): void {
    if (disposed) return;
    subscriptions.push(env.subscribeVisibility(handleVisibilityChange));
    subscriptions.push(env.subscribeReduced(handleReducedChange));

    const reducedNow = env.isReduced();
    setReducedMotion(reducedNow);
    if (reducedNow) {
      settleCalm();
      return;
    }
    if (env.isHidden()) {
      resumeOnVisible = true;
      setPlaying(false);
      return;
    }
    runSequence();
  }

  function dispose(): void {
    disposed = true;
    resumeOnVisible = false;
    clearTimers();
    while (subscriptions.length > 0) {
      const unsubscribe = subscriptions.pop();
      unsubscribe?.();
    }
  }

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
    reducedMotion,
    replay,
    pause,
    start,
    dispose,
  };
}

/**
 * Runs the scripted workbench sequence once mounted in a visible tab, with replay and pause
 * controls. Visitors with `prefers-reduced-motion: reduce` see the calm finished state.
 */
export function createDemo(): Demo {
  const controller = createDemoController();
  onMount(() => {
    controller.start();
    onCleanup(() => controller.dispose());
  });
  return controller;
}
