import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import type React from "react";

export interface MenuItem {
  readonly label: string;
  readonly hint?: string;
  readonly danger?: boolean;
  readonly testId: string;
  run(): void;
}

/**
 * A small menu at a point. Arrow keys move, Enter or a click runs an item, Escape or a click
 * anywhere else closes it and hands focus back. Items are plain buttons, so touch and keyboard
 * use the same path as the mouse.
 */
export function ContextMenu(props: {
  x: number;
  y: number;
  items: readonly MenuItem[];
  label: string;
  /** `escaped`: closed with the keyboard, so focus should go back where it was. */
  onClose(escaped?: boolean): void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const buttons = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);

  useLayoutEffect(() => {
    // Keep the menu inside the window: flip it back from the right and bottom edges.
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    element.style.left = `${Math.max(4, Math.min(props.x, window.innerWidth - box.width - 4))}px`;
    element.style.top = `${Math.max(4, Math.min(props.y, window.innerHeight - box.height - 4))}px`;
    buttons()[0]?.focus();
    // Placed once, where it opened; a menu at another point is a new menu.
  }, []);

  // Not `props.onClose` itself as a listener: it would be passed the event as `escaped`.
  const dismiss = useEffectEvent(() => props.onClose());

  useEffect(() => {
    const dismissOutside = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) dismiss();
    };
    const dismissAll = () => dismiss();
    document.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("blur", dismissAll);
    window.addEventListener("resize", dismissAll);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      window.removeEventListener("blur", dismissAll);
      window.removeEventListener("resize", dismissAll);
    };
  }, []);

  function onKeyDown(event: React.KeyboardEvent): void {
    const all = buttons();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      props.onClose(true);
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    all[(index + step + all.length) % all.length]?.focus();
  }

  return (
    <div
      ref={ref}
      className="tree-menu"
      role="menu"
      aria-label={props.label}
      data-testid="tree-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {props.items.map((item) => (
        <button
          key={item.testId}
          type="button"
          role="menuitem"
          className={item.danger ? "tree-menu-item danger" : "tree-menu-item"}
          data-testid={item.testId}
          onClick={() => {
            props.onClose();
            item.run();
          }}
        >
          <span>{item.label}</span>
          {item.hint ? <kbd>{item.hint}</kbd> : null}
        </button>
      ))}
    </div>
  );
}
