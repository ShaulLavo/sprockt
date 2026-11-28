// The title bar: brand, workspace name (a switcher once slice 1 registers one), branch, the quick
// open field, workspace actions, the dev server pill and the theme toggle. On phones the actions
// and the theme move into a menu behind a `…` button.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useValue } from "../lib/react";
import { Icon } from "../ui/icons";
import { workspaceName } from "../workspace/hint";
import type { WorkspaceSession } from "../workspace/session";
import { ui } from "./copy";
import { COMMAND, STATUS_SLOT, type Command } from "../workspace/session/slots";
import { colorScheme, setColorScheme, type ColorScheme } from "../ui/theme";

/** Workspace actions, in title bar order. */
const ACTIONS = [COMMAND.share, COMMAND.download] as const;
/** Saving, first in the phone menu: a phone has no keyboard shortcut for it. */
const EDITOR_ACTIONS = [COMMAND.save, COMMAND.saveAll, COMMAND.autosave] as const;
/** Everything the phone menu offers, in order. */
const MENU_ACTIONS: readonly string[] = (EDITOR_ACTIONS as readonly string[]).concat(
  [COMMAND.switchWorkspace],
  ACTIONS,
);

/** A registered command with the id it was registered under, and its badge count right now. */
interface Listed {
  readonly id: string;
  readonly command: Command;
  readonly badge: number;
}

/** The registered commands among `ids`, in order. Reads their badges, so a reader tracks them. */
function listCommands(session: WorkspaceSession | undefined, ids: readonly string[]): Listed[] {
  if (!session) return [];
  return ids.flatMap((id) => {
    const command = session.commands.get(id);
    return command ? [{ id, command, badge: command.badge?.() ?? 0 }] : [];
  });
}

function ThemeOption(props: { scheme: ColorScheme; label: string }) {
  const scheme = useValue(colorScheme);
  return (
    <button
      type="button"
      className="theme-option"
      aria-pressed={scheme === props.scheme}
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
    <div className="theme-toggle" role="group" aria-label={ui.workbench.theme}>
      <ThemeOption scheme="light" label={ui.workbench.themeLight} />
      <ThemeOption scheme="dark" label={ui.workbench.themeDark} />
    </div>
  );
}

function DevServerPill(props: { session: WorkspaceSession }) {
  const server = useValue(() => props.session.status.get(STATUS_SLOT.devServer));
  if (!server) return null;
  const action = server.action;
  return (
    <div className="wb-run" data-tone={server.tone ?? "neutral"} data-testid="dev-server">
      <button
        type="button"
        className="wb-run-status"
        title={server.title}
        onClick={() => server.onClick?.()}
        disabled={!server.onClick}
      >
        <span className="wb-pulse" aria-hidden="true" />
        <span className="wb-run-text">{server.text}</span>
      </button>
      {action ? (
        <button
          type="button"
          className="wb-run-action"
          aria-label={action.label}
          title={action.label}
          onClick={() => action.run()}
        >
          <Icon name={action.icon} />
        </button>
      ) : null}
    </div>
  );
}

function PhoneMenu(props: { session: WorkspaceSession | undefined }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const commands = useValue(() => listCommands(props.session, MENU_ACTIONS));
  const badged = commands.some((item) => item.badge > 0);

  function close(): void {
    setOpen(false);
    button.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="wb-menu">
      <button
        ref={button}
        type="button"
        className="wb-phone-button"
        aria-label={ui.workbench.menu}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="phone-menu"
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
        {badged ? <span className="wb-menu-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <>
          <div className="wb-scrim" aria-hidden="true" onClick={close} />
          <div className="wb-menu-panel" role="menu" aria-label={ui.workbench.menu}>
            {commands.map(({ id, command, badge }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                className="wb-menu-item"
                onClick={() => {
                  setOpen(false);
                  command.run();
                }}
              >
                {command.icon ? <Icon name={command.icon} /> : null}
                <span>{command.label}</span>
                {badge > 0 ? <span className="wb-menu-badge">{badge}</span> : null}
              </button>
            ))}
            <div className="wb-menu-theme">
              <span>{ui.workbench.theme}</span>
              <ThemeToggle />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function WorkspaceCrumb(props: { name: string; switcher: Command | undefined }) {
  const switcher = props.switcher;
  if (!switcher) {
    return (
      <span className="wb-crumb-project" data-testid="workspace-name">
        {props.name}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="wb-crumb-project wb-crumb-switch"
      aria-label={switcher.label}
      title={switcher.label}
      data-testid="workspace-name"
      onClick={() => switcher.run()}
    >
      {props.name}
      <Icon name="chev-d" />
    </button>
  );
}

function Palette(props: { quickOpen: Command | undefined }) {
  const quickOpen = props.quickOpen;
  if (!quickOpen) return <span className="wb-titlebar-fill" />;
  return (
    <button type="button" className="wb-palette" onClick={() => quickOpen.run()}>
      <Icon name="search" />
      <span className="wb-palette-text">{ui.search.commandPalette}</span>
      {quickOpen.shortcut ? <kbd>{quickOpen.shortcut}</kbd> : null}
    </button>
  );
}

export interface TitleBarProps {
  readonly workspaceId: string;
  /** The session once it started; undefined while booting, after a failure and once closed. */
  readonly session: WorkspaceSession | undefined;
  /** Workspace controls with their own UI (Share and its link popover), before the dev server. */
  readonly controls?: ReactNode;
  onHome(): void;
}

export function TitleBar(props: TitleBarProps) {
  const { session } = props;
  const { switcher, quickOpen, branch, actions } = useValue(() => ({
    switcher: session?.commands.get(COMMAND.switchWorkspace),
    quickOpen: session?.commands.get(COMMAND.quickOpen),
    branch: session?.status.get(STATUS_SLOT.branch),
    actions: listCommands(session, ACTIONS),
  }));
  // Reactive so opening an existing workspace immediately replaces its random id once hydrated.
  const name = useValue(() => workspaceName(props.workspaceId));

  return (
    <header className="wb-titlebar">
      <button
        type="button"
        className="wb-brand"
        aria-label={ui.workbench.home}
        title={ui.workbench.home}
        onClick={() => props.onHome()}
      >
        <span className="wb-brand-mark">
          <Icon name="logo" />
        </span>
        <span className="wb-brand-word">Sprockt</span>
      </button>
      <nav className="wb-crumbs" aria-label={ui.workbench.workspace}>
        <WorkspaceCrumb name={name} switcher={switcher} />
        {branch ? (
          <>
            <span className="wb-crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="wb-crumb-branch" title={branch.title}>
              <Icon name="branch" />
              {branch.text}
            </span>
          </>
        ) : null}
      </nav>
      <Palette quickOpen={quickOpen} />
      <div className="wb-titlebar-right">
        {props.controls}
        {actions.map(({ id, command }) => (
          <button
            key={id}
            type="button"
            className="icon-button wb-action"
            aria-label={command.label}
            title={command.label}
            onClick={() => command.run()}
          >
            <Icon name={command.icon ?? "share"} />
          </button>
        ))}
        {session ? <DevServerPill session={session} /> : null}
        <div className="wb-theme-desktop">
          <ThemeToggle />
        </div>
        {quickOpen ? (
          <button
            type="button"
            className="wb-phone-button wb-phone-search"
            aria-label={ui.search.commandPalette}
            onClick={() => quickOpen.run()}
          >
            <Icon name="search" />
          </button>
        ) : null}
        <PhoneMenu session={session} />
      </div>
    </header>
  );
}
