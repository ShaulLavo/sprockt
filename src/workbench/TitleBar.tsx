// The title bar: brand, workspace name (a switcher once slice 1 registers one), branch, the quick
// open field, workspace actions, the dev server pill and the theme toggle. On phones the actions
// and the theme move into a menu behind a `…` button.
import { createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js";
import { Icon } from "../ui/icons";
import { workspaceName } from "../workspace/hint";
import type { WorkspaceSession } from "../workspace/session";
import { ui } from "./copy";
import { COMMAND, STATUS_SLOT, type Command } from "./slots";
import { colorScheme, setColorScheme, type ColorScheme } from "./theme";

/** Workspace actions, in title bar order. */
const ACTIONS = [COMMAND.share, COMMAND.download] as const;
/** Saving, first in the phone menu: a phone has no keyboard shortcut for it. */
const EDITOR_ACTIONS = [COMMAND.save, COMMAND.saveAll, COMMAND.autosave] as const;

function ThemeOption(props: { scheme: ColorScheme; label: string }) {
  return (
    <button
      type="button"
      class="theme-option"
      aria-pressed={colorScheme() === props.scheme}
      aria-label={props.label}
      title={props.label}
      onClick={() => setColorScheme(props.scheme)}
    >
      <Icon name={props.scheme === "light" ? "sun" : "moon"} />
    </button>
  );
}

export function ThemeToggle() {
  return (
    <div class="theme-toggle" role="group" aria-label={ui.workbench.theme}>
      <ThemeOption scheme="light" label={ui.workbench.themeLight} />
      <ThemeOption scheme="dark" label={ui.workbench.themeDark} />
    </div>
  );
}

function DevServerPill(props: { session: WorkspaceSession }) {
  const item = () => props.session.status.get(STATUS_SLOT.devServer);
  return (
    <Show when={item()}>
      {(server) => (
        <div class="wb-run" data-tone={server().tone ?? "neutral"} data-testid="dev-server">
          <button
            type="button"
            class="wb-run-status"
            title={server().title}
            onClick={() => server().onClick?.()}
            disabled={!server().onClick}
          >
            <span class="wb-pulse" aria-hidden="true" />
            <span class="wb-run-text">{server().text}</span>
          </button>
          <Show when={server().action}>
            {(action) => (
              <button
                type="button"
                class="wb-run-action"
                aria-label={action().label}
                title={action().label}
                onClick={() => action().run()}
              >
                <Icon name={action().icon} />
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

function PhoneMenu(props: { session: WorkspaceSession | undefined }) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  const commands = (): readonly Command[] => {
    const session = props.session;
    if (!session) return [];
    const ids: readonly string[] = (EDITOR_ACTIONS as readonly string[]).concat(
      [COMMAND.switchWorkspace],
      ACTIONS,
    );
    return ids.flatMap((id) => session.commands.get(id) ?? []);
  };
  const badged = () => commands().some((command) => (command.badge?.() ?? 0) > 0);

  function close(): void {
    setOpen(false);
    button?.focus();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && open()) close();
  }
  addEventListener("keydown", onKey);
  onCleanup(() => removeEventListener("keydown", onKey));

  return (
    <div class="wb-menu">
      <button
        ref={(element) => (button = element)}
        type="button"
        class="wb-phone-button"
        aria-label={ui.workbench.menu}
        aria-haspopup="menu"
        aria-expanded={open()}
        data-testid="phone-menu"
        onClick={() => setOpen(!open())}
      >
        <Icon name="more" />
        <Show when={badged()}>
          <span class="wb-menu-dot" aria-hidden="true" />
        </Show>
      </button>
      <Show when={open()}>
        <div class="wb-scrim" aria-hidden="true" onClick={close} />
        <div class="wb-menu-panel" role="menu" aria-label={ui.workbench.menu}>
          <For each={commands()}>
            {(command) => (
              <button
                type="button"
                role="menuitem"
                class="wb-menu-item"
                onClick={() => {
                  setOpen(false);
                  command.run();
                }}
              >
                <Show when={command.icon}>{(icon) => <Icon name={icon()} />}</Show>
                <span>{command.label}</span>
                <Show when={(command.badge?.() ?? 0) > 0}>
                  <span class="wb-menu-badge">{command.badge?.()}</span>
                </Show>
              </button>
            )}
          </For>
          <div class="wb-menu-theme">
            <span>{ui.workbench.theme}</span>
            <ThemeToggle />
          </div>
        </div>
      </Show>
    </div>
  );
}

export interface TitleBarProps {
  readonly workspaceId: string;
  readonly session: Accessor<WorkspaceSession | undefined>;
  /** Workspace controls with their own UI (Share and its link popover), before the dev server. */
  readonly controls?: JSX.Element;
  onHome(): void;
}

export function TitleBar(props: TitleBarProps) {
  const command = (id: string) => props.session()?.commands.get(id);
  const branch = () => props.session()?.status.get(STATUS_SLOT.branch);
  const actions = () => ACTIONS.flatMap((id) => command(id) ?? []);
  // The name the workspace was given, shown once; its random id only when this browser has none.
  const name = workspaceName(props.workspaceId);

  return (
    <header class="wb-titlebar">
      <button
        type="button"
        class="wb-brand"
        aria-label={ui.workbench.home}
        title={ui.workbench.home}
        onClick={() => props.onHome()}
      >
        <span class="wb-brand-mark">
          <Icon name="logo" />
        </span>
        <span class="wb-brand-word">Sprockt</span>
      </button>
      <nav class="wb-crumbs" aria-label={ui.workbench.workspace}>
        <Show
          when={command(COMMAND.switchWorkspace)}
          fallback={
            <span class="wb-crumb-project" data-testid="workspace-name">
              {name}
            </span>
          }
        >
          {(switcher) => (
            <button
              type="button"
              class="wb-crumb-project wb-crumb-switch"
              aria-label={switcher().label}
              title={switcher().label}
              data-testid="workspace-name"
              onClick={() => switcher().run()}
            >
              {name}
              <Icon name="chev-d" />
            </button>
          )}
        </Show>
        <Show when={branch()}>
          {(item) => (
            <>
              <span class="wb-crumb-sep" aria-hidden="true">
                /
              </span>
              <span class="wb-crumb-branch" title={item().title}>
                <Icon name="branch" />
                {item().text}
              </span>
            </>
          )}
        </Show>
      </nav>
      <Show when={command(COMMAND.quickOpen)} fallback={<span class="wb-titlebar-fill" />}>
        {(quickOpen) => (
          <button type="button" class="wb-palette" onClick={() => quickOpen().run()}>
            <Icon name="search" />
            <span class="wb-palette-text">{ui.search.commandPalette}</span>
            <Show when={quickOpen().shortcut}>
              <kbd>{quickOpen().shortcut}</kbd>
            </Show>
          </button>
        )}
      </Show>
      <div class="wb-titlebar-right">
        {props.controls}
        <For each={actions()}>
          {(action) => (
            <button
              type="button"
              class="icon-button wb-action"
              aria-label={action.label}
              title={action.label}
              onClick={() => action.run()}
            >
              <Icon name={action.icon ?? "share"} />
            </button>
          )}
        </For>
        <Show when={props.session()}>{(session) => <DevServerPill session={session()} />}</Show>
        <div class="wb-theme-desktop">
          <ThemeToggle />
        </div>
        <Show when={command(COMMAND.quickOpen)}>
          {(quickOpen) => (
            <button
              type="button"
              class="wb-phone-button wb-phone-search"
              aria-label={ui.search.commandPalette}
              onClick={() => quickOpen().run()}
            >
              <Icon name="search" />
            </button>
          )}
        </Show>
        <PhoneMenu session={props.session()} />
      </div>
    </header>
  );
}
