import { For, onCleanup, onMount } from "solid-js";

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
  let element: HTMLDivElement | undefined;

  const buttons = () => Array.from(element?.querySelectorAll<HTMLButtonElement>("button") ?? []);

  onMount(() => {
    // Keep the menu inside the window: flip it back from the right and bottom edges.
    if (!element) return;
    const box = element.getBoundingClientRect();
    element.style.left = `${Math.max(4, Math.min(props.x, window.innerWidth - box.width - 4))}px`;
    element.style.top = `${Math.max(4, Math.min(props.y, window.innerHeight - box.height - 4))}px`;
    buttons()[0]?.focus();
  });

  // Not `props.onClose` itself as a listener: it would be passed the event as `escaped`.
  const dismiss = () => props.onClose();
  const dismissOutside = (event: Event) => {
    if (!element?.contains(event.target as Node)) dismiss();
  };

  onMount(() => {
    document.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", dismissOutside, true);
    window.removeEventListener("blur", dismiss);
    window.removeEventListener("resize", dismiss);
  });

  function onKeyDown(event: KeyboardEvent): void {
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
      ref={(node) => (element = node)}
      class="tree-menu"
      role="menu"
      aria-label={props.label}
      data-testid="tree-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="menuitem"
            class="tree-menu-item"
            classList={{ danger: item.danger }}
            data-testid={item.testId}
            onClick={() => {
              props.onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.hint ? <kbd>{item.hint}</kbd> : null}
          </button>
        )}
      </For>
    </div>
  );
}
