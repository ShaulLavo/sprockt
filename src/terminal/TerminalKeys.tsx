// Keys a phone keyboard lacks, shown under the terminal on narrow screens. Ctrl is sticky: it
// turns the next letter typed on the keyboard into its Control chord. The buttons never take
// focus, so the keyboard stays open while they are tapped.
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { useValue } from "../lib/react";
import type { Accessor } from "../lib/reactive";
import { trackOverflowFade } from "../ui/fade";
import { ui } from "./copy";
import type { TerminalHandle } from "./session";

interface SoftKey {
  readonly label: string;
  readonly name: string;
  readonly data: string;
  /** When set, dispatches a hardware KeyboardEvent so Ghostty encodes DECCKM/TUI modes cleanly. */
  readonly key?: string;
  readonly code?: string;
}

/** Shown before the Ctrl key. */
const LEADING: readonly SoftKey[] = [
  { label: "esc", name: "Escape", data: "\x1b", key: "Escape", code: "Escape" },
  { label: "tab", name: "Tab", data: "\t", key: "Tab", code: "Tab" },
];

/** Shown after the Ctrl key. Ctrl+C comes first: stopping a dev server takes one tap. */
const TRAILING: readonly SoftKey[] = [
  { label: "^C", name: "Control+C", data: "\x03" },
  { label: "↑", name: "Up", data: "\x1b[A", key: "ArrowUp", code: "ArrowUp" },
  { label: "↓", name: "Down", data: "\x1b[B", key: "ArrowDown", code: "ArrowDown" },
  { label: "←", name: "Left", data: "\x1b[D", key: "ArrowLeft", code: "ArrowLeft" },
  { label: "→", name: "Right", data: "\x1b[C", key: "ArrowRight", code: "ArrowRight" },
  { label: "|", name: "|", data: "|" },
  { label: "~", name: "~", data: "~" },
  { label: "/", name: "/", data: "/" },
  { label: "-", name: "-", data: "-" },
];

/** Keeps focus (and the on-screen keyboard) where it is. */
const keepFocus = (event: React.SyntheticEvent) => event.preventDefault();

export function TerminalKeys(props: {
  handle: Accessor<TerminalHandle | undefined>;
  /** False while the terminal is off screen, such as another pane on a phone. */
  shown: boolean;
}) {
  const [control, setControl] = useState(false);
  /** The shell Ctrl was armed on. Only that shell's next letter becomes a chord. */
  const owner = useRef<TerminalHandle | undefined>(undefined);
  const row = useRef<HTMLDivElement>(null);
  const current = useValue(props.handle);

  useEffect(() => (row.current ? trackOverflowFade(row.current) : undefined), []);

  function disarm(): void {
    owner.current?.disarmControl();
    owner.current = undefined;
    setControl(false);
  }

  // Moving to another terminal lets go of Ctrl, so the shell left behind gets no surprise chord.
  useEffect(() => {
    if (owner.current && owner.current !== current) disarm();
  }, [current]);

  // So does leaving the terminal for another pane.
  useEffect(() => {
    if (!props.shown && owner.current) disarm();
  }, [props.shown]);

  useEffect(
    () => () => {
      owner.current?.disarmControl();
      owner.current = undefined;
    },
    [],
  );

  function toggleControl(): void {
    const handle = props.handle();
    if (!handle) return;
    if (owner.current) return disarm();
    owner.current = handle;
    handle.armControl(() => {
      if (owner.current !== handle) return;
      owner.current = undefined;
      setControl(false);
    });
    setControl(true);
    handle.focus();
  }

  function send(softKey: SoftKey): void {
    const handle = props.handle();
    if (!handle) return;
    disarm();
    if (softKey.key && softKey.code) handle.pressKey(softKey.key, softKey.code, softKey.data);
    else handle.input(softKey.data);
    handle.focus();
  }

  const renderKey = (key: SoftKey) => (
    <button
      key={key.name}
      type="button"
      className="term-key"
      aria-label={key.name}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={() => send(key)}
    >
      {key.label}
    </button>
  );

  return (
    <div className="term-keys" role="toolbar" aria-label={ui.terminalKeys} ref={row}>
      {LEADING.map(renderKey)}
      <button
        type="button"
        className="term-key is-mod"
        aria-pressed={control}
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={toggleControl}
      >
        ctrl
      </button>
      {TRAILING.map(renderKey)}
    </div>
  );
}
