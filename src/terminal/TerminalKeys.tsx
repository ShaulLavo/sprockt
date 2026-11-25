// Keys a phone keyboard lacks, shown under the terminal on narrow screens. Ctrl is sticky: it
// turns the next letter typed on the keyboard into its Control chord. The buttons never take
// focus, so the keyboard stays open while they are tapped.
import { createEffect, createSignal, For, on, onCleanup, onMount, type Accessor } from "solid-js";
import { trackOverflowFade } from "../ui/fade";
import { ui } from "./copy";
import type { TerminalHandle } from "./session";

interface SoftKey {
  readonly label: string;
  readonly name: string;
  readonly data: string;
}

/** Shown before the Ctrl key. */
const LEADING: readonly SoftKey[] = [
  { label: "esc", name: "Escape", data: "\x1b" },
  { label: "tab", name: "Tab", data: "\t" },
];

/** Shown after the Ctrl key. */
const TRAILING: readonly SoftKey[] = [
  { label: "↑", name: "Up", data: "\x1b[A" },
  { label: "↓", name: "Down", data: "\x1b[B" },
  { label: "←", name: "Left", data: "\x1b[D" },
  { label: "→", name: "Right", data: "\x1b[C" },
  { label: "|", name: "|", data: "|" },
  { label: "~", name: "~", data: "~" },
  { label: "/", name: "/", data: "/" },
  { label: "-", name: "-", data: "-" },
];

/** Keeps focus (and the on-screen keyboard) where it is. */
const keepFocus = (event: Event) => event.preventDefault();

export function TerminalKeys(props: {
  handle: Accessor<TerminalHandle | undefined>;
  /** False while the terminal is off screen, such as another pane on a phone. */
  shown: boolean;
}) {
  const [control, setControl] = createSignal(false);
  /** The shell Ctrl was armed on. Only that shell's next letter becomes a chord. */
  let owner: TerminalHandle | undefined;
  let row: HTMLDivElement | undefined;
  onMount(() => row && onCleanup(trackOverflowFade(row)));

  function disarm(): void {
    owner?.disarmControl();
    owner = undefined;
    setControl(false);
  }

  // Moving to another terminal lets go of Ctrl, so the shell left behind gets no surprise chord.
  createEffect(
    on(props.handle, (handle) => {
      if (owner && owner !== handle) disarm();
    }),
  );
  // So does leaving the terminal for another pane.
  createEffect(
    on(
      () => props.shown,
      (shown) => {
        if (!shown && owner) disarm();
      },
    ),
  );
  onCleanup(disarm);

  function toggleControl(): void {
    const handle = props.handle();
    if (!handle) return;
    if (owner) return disarm();
    owner = handle;
    handle.armControl(() => {
      if (owner !== handle) return;
      owner = undefined;
      setControl(false);
    });
    setControl(true);
    handle.focus();
  }

  function send(data: string): void {
    const handle = props.handle();
    if (!handle) return;
    disarm();
    handle.input(data);
    handle.focus();
  }

  const Key = (key: SoftKey) => (
    <button
      type="button"
      class="term-key"
      aria-label={key.name}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={() => send(key.data)}
    >
      {key.label}
    </button>
  );

  return (
    <div class="term-keys" role="toolbar" aria-label={ui.terminalKeys} ref={(element) => (row = element)}>
      <For each={LEADING}>{Key}</For>
      <button
        type="button"
        class="term-key is-mod"
        aria-pressed={control()}
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={toggleControl}
      >
        ctrl
      </button>
      <For each={TRAILING}>{Key}</For>
    </div>
  );
}
