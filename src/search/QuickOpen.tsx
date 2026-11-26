// Cmd/Ctrl+P: a fuzzy file finder over the project. `name:12` or `name:12:4` opens at a line.
import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { FileService } from "../files/service";
import { useValue } from "../lib/react";
import type { Accessor } from "../lib/reactive";
import { SEARCH_COPY } from "./copy";
import { commandsOnly, matchCommands, type PaletteCommand } from "./commands";
import { rankPaths, splitLocation, type FuzzyMatch } from "./fuzzy";
import { CommandIcon, FileIcon, Highlighted, SearchIcon } from "./icons";
import { createQuickOpenSession } from "./quick-open-state";
import "./search.css";

const LIMIT = 50;
const NO_COMMANDS: readonly PaletteCommand[] = [];
const NO_PATHS: readonly string[] = [];

export interface QuickOpenProps {
  readonly files: Pick<FileService, "list" | "revision">;
  /** Open tabs, offered first while the query is empty. */
  readonly recent: Accessor<readonly string[]>;
  readonly onOpen: (path: string, location: { line?: number; column?: number }) => void;
  readonly onClose: () => void;
  /** Commands it finds too (commands.ts says when). */
  readonly commands?: Accessor<readonly PaletteCommand[]>;
  /** Initial text placed in the field when opening (for example `>` for commands-only mode). */
  readonly initialQuery?: string;
}

type Item =
  | { readonly kind: "command"; readonly command: PaletteCommand }
  | { readonly kind: "file"; readonly match: FuzzyMatch };

/** Keeps the selected row in view. */
function useScrolledIntoView(selected: boolean) {
  const element = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) element.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return element;
}

function CommandRow(props: {
  command: PaletteCommand;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const element = useScrolledIntoView(props.selected);
  return (
    <li
      ref={element}
      role="option"
      className={props.selected ? "quick-open-row is-selected" : "quick-open-row"}
      aria-selected={props.selected}
      data-testid="quick-open-command"
      data-command={props.command.id}
      onPointerMove={() => props.onHover()}
      onClick={() => props.onPick()}
    >
      <CommandIcon />
      <span className="quick-open-name">{props.command.label}</span>
      {props.command.shortcut ? <span className="quick-open-dir">{props.command.shortcut}</span> : null}
    </li>
  );
}

function emptyQueryResults(paths: readonly string[], recent: readonly string[]): FuzzyMatch[] {
  const known = new Set(paths);
  const first = recent.filter((path) => known.has(path));
  const firstSet = new Set(first);
  const rest = rankPaths("", paths, LIMIT).filter((match) => !firstSet.has(match.path));
  return first
    .map((path): FuzzyMatch => ({ path, score: 0, positions: [] }))
    .concat(rest)
    .slice(0, LIMIT);
}

function Row(props: { match: FuzzyMatch; selected: boolean; onPick: () => void; onHover: () => void }) {
  const { match } = props;
  const nameStart = match.path.lastIndexOf("/") + 1;
  const marks = (offset: number) => new Set(match.positions.map((position) => position - offset));
  const element = useScrolledIntoView(props.selected);
  return (
    <li
      ref={element}
      role="option"
      className={props.selected ? "quick-open-row is-selected" : "quick-open-row"}
      aria-selected={props.selected}
      data-testid="quick-open-result"
      data-path={match.path}
      onPointerMove={() => props.onHover()}
      onClick={() => props.onPick()}
    >
      <FileIcon path={match.path} />
      <span className="quick-open-name">
        <Highlighted text={match.path.slice(nameStart)} marks={marks(nameStart)} />
      </span>
      <span className="quick-open-dir">
        <Highlighted text={match.path.slice(0, Math.max(nameStart - 1, 0))} marks={marks(0)} />
      </span>
    </li>
  );
}

function rankFiles(query: string, paths: readonly string[], recent: readonly string[]): FuzzyMatch[] {
  if (commandsOnly(query)) return [];
  const text = splitLocation(query).text;
  return text ? rankPaths(text, paths, LIMIT) : emptyQueryResults(paths, recent);
}

function rankItems(
  query: string,
  paths: readonly string[],
  recent: readonly string[],
  commands: readonly PaletteCommand[],
): Item[] {
  // Commands it finds come first: a phone reaches Save by typing "sav".
  const found: Item[] = matchCommands(query, commands).map((command) => ({ kind: "command", command }));
  return found.concat(rankFiles(query, paths, recent).map((match): Item => ({ kind: "file", match })));
}

function itemKey(item: Item): string {
  return item.kind === "command" ? `command:${item.command.id}` : `file:${item.match.path}`;
}

function Dialog(props: QuickOpenProps) {
  const [query, setQuery] = useState(props.initialQuery ?? "");
  // A plain state, not a suspending resource: a listing that is loading must not suspend the workbench.
  const [paths, setPaths] = useState<readonly string[]>(NO_PATHS);
  // A listing that landed after Enter was pressed asks for the pick once the results include it.
  const [submitLanded, setSubmitLanded] = useState(0);
  const [session] = useState(createQuickOpenSession);
  const revision = useValue(props.files.revision);
  const recent = useValue(props.recent);
  const commands = useValue(() => props.commands?.() ?? NO_COMMANDS);
  const input = useRef<HTMLInputElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const picked = useRef(false);

  const location = splitLocation(query);
  const results = useMemo(() => rankItems(query, paths, recent, commands), [query, paths, recent, commands]);
  // The selection belongs to the results it was made in: new results start at the top again.
  const [selection, setSelection] = useState({ results, index: 0 });
  const selected = selection.results === results ? selection.index : 0;
  const select = (index: number) => setSelection({ results, index });

  useEffect(() => () => session.close(), [session]);
  useEffect(() => {
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const field = input.current;
    if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
    return () => {
      if (!picked.current && origin.current?.isConnected) origin.current.focus();
    };
  }, []);

  useEffect(() => {
    const landed = (request: number, list: readonly string[]): void => {
      const outcome = session.finishListing(request);
      if (!outcome.accept) return;
      setPaths(list);
      if (outcome.submit) setSubmitLanded((count) => count + 1);
    };
    const request = session.beginListing();
    // Only the newest listing lands, and none after the dialog closed.
    void props.files.list().then(
      (list) => landed(request, list),
      () => session.failListing(request),
    );
  }, [props.files, revision, session]);

  useEffect(() => {
    if (submitLanded > 0) pick(results[selected]);
    // Runs once per landing; the pick reads the results that landing produced.
  }, [submitLanded]);

  function pick(item: Item | undefined): void {
    if (!item) return;
    picked.current = true;
    props.onClose();
    if (item.kind === "command") return item.command.run();
    props.onOpen(item.match.path, { line: location.line, column: location.column });
  }

  function submit(): void {
    if (session.submit(commandsOnly(query)) === "now") pick(results[selected]);
  }

  function stepSelection(delta: number, count: number): void {
    session.cancelPending();
    select((selected + delta + count) % count);
  }

  function hover(index: number): void {
    session.cancelPending();
    select(index);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const count = results.length;
    if (event.key === "Escape") props.onClose();
    else if (event.key === "Enter") submit();
    else if (event.key === "ArrowDown" && count > 0) stepSelection(1, count);
    else if (event.key === "ArrowUp" && count > 0) stepSelection(-1, count);
    else return;
    event.preventDefault();
  }

  function onBlur(event: FocusEvent<HTMLInputElement>): void {
    // Leaving the dialog (not just moving within it) closes it.
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.closest(".quick-open")?.contains(next)) props.onClose();
  }

  const rows = results.map((item, index) =>
    item.kind === "command" ? (
      <CommandRow
        key={itemKey(item)}
        command={item.command}
        selected={selected === index}
        onPick={() => pick(item)}
        onHover={() => hover(index)}
      />
    ) : (
      <Row
        key={itemKey(item)}
        match={item.match}
        selected={selected === index}
        onPick={() => pick(item)}
        onHover={() => hover(index)}
      />
    ),
  );

  return (
    <div
      className="quick-open-backdrop"
      onPointerDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div className="quick-open" role="dialog" aria-label={SEARCH_COPY.quickOpen} data-testid="quick-open">
        <label className="quick-open-field">
          <SearchIcon />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-open-list"
            aria-label={SEARCH_COPY.quickOpen}
            placeholder={SEARCH_COPY.quickOpen}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              session.cancelPending();
              setQuery(event.currentTarget.value);
            }}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
          />
        </label>
        <ul
          id="quick-open-list"
          className="quick-open-list"
          role="listbox"
          onPointerDown={(event) => event.preventDefault()}
        >
          {rows.length > 0 ? rows : <li className="quick-open-empty">{SEARCH_COPY.noFileResults}</li>}
        </ul>
      </div>
    </div>
  );
}

export function QuickOpen(props: QuickOpenProps & { readonly open: Accessor<boolean> }) {
  const open = useValue(props.open);
  if (!open) return null;
  // Solid's Portal mounted into a wrapper div in the body; keep that structure.
  return createPortal(<PortalHost {...props} />, document.body);
}

/** The body-level wrapper the dialog renders into, as before. */
function PortalHost(props: QuickOpenProps) {
  return (
    <div>
      <Dialog {...props} />
    </div>
  );
}
