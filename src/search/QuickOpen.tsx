// Cmd/Ctrl+P: a fuzzy file finder over the project. `name:12` or `name:12:4` opens at a line.
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  For,
  onMount,
  Show,
  type Accessor,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { FileService } from "../files/service";
import { SEARCH_COPY } from "./copy";
import { commandsOnly, matchCommands, type PaletteCommand } from "./commands";
import { rankPaths, splitLocation, type FuzzyMatch } from "./fuzzy";
import { CommandIcon, FileIcon, Highlighted, SearchIcon } from "./icons";
import "./search.css";

const LIMIT = 50;

export interface QuickOpenProps {
  readonly files: Pick<FileService, "list" | "revision">;
  /** Open tabs, offered first while the query is empty. */
  readonly recent: Accessor<readonly string[]>;
  readonly onOpen: (path: string, location: { line?: number; column?: number }) => void;
  readonly onClose: () => void;
  /** Commands it finds too (commands.ts says when). */
  readonly commands?: Accessor<readonly PaletteCommand[]>;
}

type Item =
  | { readonly kind: "command"; readonly command: PaletteCommand }
  | { readonly kind: "file"; readonly match: FuzzyMatch };

function CommandRow(props: {
  command: PaletteCommand;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  let element!: HTMLLIElement;
  createEffect(() => {
    if (props.selected) element.scrollIntoView({ block: "nearest" });
  });
  return (
    <li
      ref={(node) => (element = node)}
      role="option"
      class="quick-open-row"
      classList={{ "is-selected": props.selected }}
      aria-selected={props.selected}
      data-testid="quick-open-command"
      data-command={props.command.id}
      onPointerMove={() => props.onHover()}
      onClick={() => props.onPick()}
    >
      <CommandIcon />
      <span class="quick-open-name">{props.command.label}</span>
      <Show when={props.command.shortcut}>
        <span class="quick-open-dir">{props.command.shortcut}</span>
      </Show>
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
  const nameStart = () => props.match.path.lastIndexOf("/") + 1;
  const marks = (offset: number) => new Set(props.match.positions.map((position) => position - offset));
  let element!: HTMLLIElement;
  createEffect(() => {
    if (props.selected) element.scrollIntoView({ block: "nearest" });
  });
  return (
    <li
      ref={(node) => (element = node)}
      role="option"
      class="quick-open-row"
      classList={{ "is-selected": props.selected }}
      aria-selected={props.selected}
      data-testid="quick-open-result"
      data-path={props.match.path}
      onPointerMove={() => props.onHover()}
      onClick={() => props.onPick()}
    >
      <FileIcon path={props.match.path} />
      <span class="quick-open-name">
        <Highlighted text={props.match.path.slice(nameStart())} marks={marks(nameStart())} />
      </span>
      <span class="quick-open-dir">
        <Highlighted text={props.match.path.slice(0, Math.max(nameStart() - 1, 0))} marks={marks(0)} />
      </span>
    </li>
  );
}

function Dialog(props: QuickOpenProps) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  // A plain signal, not a resource: a resource that is loading would suspend the workbench.
  const [paths, setPaths] = createSignal<readonly string[]>([]);
  let listing = 0;
  let open = true;
  // Enter pressed before the first listing arrived: it opens the best match once there is one.
  let listed = false;
  let enterWaiting = false;
  onCleanup(() => (open = false));
  function landed(list: readonly string[]): void {
    setPaths(list);
    listed = true;
    if (!enterWaiting) return;
    enterWaiting = false;
    pick(results()[0]);
  }
  createEffect(
    on(props.files.revision, () => {
      listing += 1;
      const mine = listing;
      // Only the newest listing lands, and none after the dialog closed.
      void props.files.list().then(
        (list) => open && mine === listing && landed(list),
        () => {},
      );
    }),
  );
  const location = createMemo(() => splitLocation(query()));
  const files = createMemo(() => {
    if (commandsOnly(query())) return [];
    const text = location().text;
    return text ? rankPaths(text, paths(), LIMIT) : emptyQueryResults(paths(), props.recent());
  });
  // Commands it finds come first: a phone reaches Save by typing "sav".
  const results = createMemo(() => {
    const commands: Item[] = matchCommands(query(), props.commands?.() ?? []).map((command) => ({
      kind: "command",
      command,
    }));
    return commands.concat(files().map((match): Item => ({ kind: "file", match })));
  });
  let input!: HTMLInputElement;

  createEffect(() => {
    results();
    setSelected(0);
  });
  onMount(() => input.focus());

  function pick(item: Item | undefined): void {
    if (!item) return;
    props.onClose();
    if (item.kind === "command") return item.command.run();
    props.onOpen(item.match.path, { line: location().line, column: location().column });
  }

  function onKeyDown(event: KeyboardEvent): void {
    const count = results().length;
    if (event.key === "Escape") props.onClose();
    else if (event.key === "Enter" && !listed && !commandsOnly(query())) enterWaiting = true;
    else if (event.key === "Enter") pick(results()[selected()]);
    else if (event.key === "ArrowDown" && count > 0) setSelected((selected() + 1) % count);
    else if (event.key === "ArrowUp" && count > 0) setSelected((selected() - 1 + count) % count);
    else return;
    event.preventDefault();
  }

  return (
    <div
      class="quick-open-backdrop"
      onPointerDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div class="quick-open" role="dialog" aria-label={SEARCH_COPY.quickOpen} data-testid="quick-open">
        <label class="quick-open-field">
          <SearchIcon />
          <input
            ref={(node) => (input = node)}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-open-list"
            aria-label={SEARCH_COPY.quickOpen}
            placeholder={SEARCH_COPY.quickOpen}
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              // Leaving the dialog (not just moving within it) closes it.
              const next = event.relatedTarget as Node | null;
              if (!next || !event.currentTarget.closest(".quick-open")?.contains(next)) props.onClose();
            }}
          />
        </label>
        <ul
          id="quick-open-list"
          class="quick-open-list"
          role="listbox"
          onPointerDown={(event) => event.preventDefault()}
        >
          <For each={results()} fallback={<li class="quick-open-empty">{SEARCH_COPY.noFileResults}</li>}>
            {(item, index) =>
              item.kind === "command" ? (
                <CommandRow
                  command={item.command}
                  selected={selected() === index()}
                  onPick={() => pick(item)}
                  onHover={() => setSelected(index())}
                />
              ) : (
                <Row
                  match={item.match}
                  selected={selected() === index()}
                  onPick={() => pick(item)}
                  onHover={() => setSelected(index())}
                />
              )
            }
          </For>
        </ul>
      </div>
    </div>
  );
}

export function QuickOpen(props: QuickOpenProps & { readonly open: Accessor<boolean> }) {
  return (
    <Show when={props.open()}>
      <Portal>
        <Dialog {...props} />
      </Portal>
    </Show>
  );
}
