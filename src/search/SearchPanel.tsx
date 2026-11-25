// Cmd/Ctrl+Shift+F: search across the project's files. Typing re-runs the search after a short
// pause; results stream in grouped by file, and a click opens the file at the match.
import { createEffect, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js";
import type { FileService } from "../files/service";
import { fill, SEARCH_COPY } from "./copy";
import { ChevronIcon, CloseIcon, FileIcon, SearchIcon } from "./icons";
import { searchProject, type FileMatches, type ProjectSearchSummary } from "./project";
import type { LineMatch } from "./text";
import { createWorkerMatcher, type WorkerMatcher } from "./worker-matcher";
import "./search.css";

const DEBOUNCE_MS = 200;

type Status = ProjectSearchSummary | { readonly kind: "idle" } | { readonly kind: "running" };

export interface SearchPanelProps {
  readonly files: Pick<FileService, "list" | "readBytes">;
  readonly onOpen: (path: string, location: { line: number; column: number }) => void;
  readonly onClose: () => void;
  /** Each change focuses the query field. */
  readonly focusRequest: Accessor<number>;
}

function Toggle(props: { label: string; text: string; pressed: Accessor<boolean>; onToggle: () => void }) {
  return (
    <button
      type="button"
      class="search-toggle"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed()}
      onClick={() => props.onToggle()}
    >
      {props.text}
    </button>
  );
}

function MatchRow(props: { match: LineMatch; onOpen: () => void }) {
  // Leading indentation is noise in a result list; trim it and keep the match position right.
  const indent = () =>
    Math.min(props.match.preview.length - props.match.preview.trimStart().length, props.match.previewStart);
  const start = () => props.match.previewStart - indent();
  const text = () => props.match.preview.slice(indent());
  return (
    <li>
      <button type="button" class="search-match" data-testid="search-result" onClick={() => props.onOpen()}>
        <span class="search-match-line">{props.match.line}</span>
        <span class="search-match-text">
          {text().slice(0, start())}
          <mark>{text().slice(start(), start() + props.match.length)}</mark>
          {text().slice(start() + props.match.length)}
        </span>
      </button>
    </li>
  );
}

function FileGroup(props: { result: FileMatches; onOpen: SearchPanelProps["onOpen"] }) {
  const [open, setOpen] = createSignal(true);
  const name = () => props.result.path.slice(props.result.path.lastIndexOf("/") + 1);
  const dir = () => props.result.path.slice(0, Math.max(props.result.path.lastIndexOf("/"), 0));
  return (
    <li class="search-file" data-testid="search-file" data-path={props.result.path}>
      <button type="button" class="search-file-row" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <ChevronIcon class={open() ? "is-open" : ""} />
        <FileIcon path={props.result.path} />
        <span class="search-file-name">{name()}</span>
        <span class="search-file-dir">{dir()}</span>
        <span class="search-file-count">{props.result.matches.length}</span>
      </button>
      <Show when={open()}>
        <ul class="search-matches">
          <For each={props.result.matches}>
            {(match) => (
              <MatchRow
                match={match}
                onOpen={() => props.onOpen(props.result.path, { line: match.line, column: match.column })}
              />
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

function summaryText(status: Status, fileCount: number): string {
  if (status.kind === "invalid") return status.message;
  if (status.kind === "failed") return fill(SEARCH_COPY.searchFailed, { message: status.message });
  if (status.kind === "running") return SEARCH_COPY.searching;
  if (status.kind !== "done") return "";
  if (status.matches === 0) return SEARCH_COPY.noSearchResults;
  if (status.truncated) return fill(SEARCH_COPY.truncated, { matches: status.matches });
  if (status.matches === 1) return SEARCH_COPY.resultOneInOne;
  if (fileCount === 1) return fill(SEARCH_COPY.resultManyInOne, { matches: status.matches });
  return fill(SEARCH_COPY.resultCount, { matches: status.matches, files: fileCount });
}

export function SearchPanel(props: SearchPanelProps) {
  const [text, setText] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [wholeWord, setWholeWord] = createSignal(false);
  const [regex, setRegex] = createSignal(false);
  const [include, setInclude] = createSignal("");
  const [exclude, setExclude] = createSignal("");
  const [results, setResults] = createSignal<readonly FileMatches[]>([]);
  const [status, setStatus] = createSignal<Status>({ kind: "idle" });
  let input!: HTMLInputElement;
  let running: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function finish(
    lifetime: AbortController,
    search: Promise<ProjectSearchSummary>,
    flush: () => void,
    matcher: WorkerMatcher,
  ) {
    const summary = await search
      .catch((error: unknown): ProjectSearchSummary => ({ kind: "failed", message: String(error) }))
      .finally(() => matcher.dispose());
    if (lifetime.signal.aborted) return;
    flush();
    setStatus(summary);
  }

  function run(): void {
    clearTimeout(timer);
    running?.abort();
    const lifetime = new AbortController();
    running = lifetime;
    setResults([]);
    if (!text()) return void setStatus({ kind: "idle" });
    setStatus({ kind: "running" });
    // Files arrive faster than frames; gather them and paint once per frame.
    let batch: FileMatches[] = [];
    const flush = () => {
      if (lifetime.signal.aborted || batch.length === 0) return;
      setResults((current) => current.concat(batch));
      batch = [];
    };
    // Matching runs in a worker of this run's own; aborting the run terminates it.
    const matcher = createWorkerMatcher(lifetime.signal);
    const request = {
      query: { text: text(), caseSensitive: caseSensitive(), wholeWord: wholeWord(), regex: regex() },
      include: include(),
      exclude: exclude(),
      signal: lifetime.signal,
      match: matcher.match,
      onFile: (result: FileMatches) => {
        if (batch.length === 0) requestAnimationFrame(flush);
        batch.push(result);
      },
    };
    void finish(lifetime, searchProject(props.files, request), flush, matcher);
  }

  createEffect(
    on(
      [text, caseSensitive, wholeWord, regex, include, exclude],
      () => {
        clearTimeout(timer);
        timer = setTimeout(run, DEBOUNCE_MS);
      },
      { defer: true },
    ),
  );
  createEffect(on(props.focusRequest, () => queueMicrotask(() => input.select())));
  onCleanup(() => {
    clearTimeout(timer);
    running?.abort();
  });

  const onFieldKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") run();
    if (event.key === "Escape") props.onClose();
  };

  return (
    <aside class="search-panel" aria-label={SEARCH_COPY.search} data-testid="search-panel">
      <header class="search-head">
        <span class="search-title">{SEARCH_COPY.search}</span>
        <button
          type="button"
          class="search-close"
          aria-label={SEARCH_COPY.closeSearch}
          onClick={() => props.onClose()}
        >
          <CloseIcon />
        </button>
      </header>
      <div class="search-fields">
        <div class="search-query">
          <SearchIcon />
          <input
            ref={(node) => (input = node)}
            type="text"
            aria-label={SEARCH_COPY.searchWorkspace}
            placeholder={SEARCH_COPY.searchWorkspace}
            autocomplete="off"
            spellcheck={false}
            data-testid="search-input"
            value={text()}
            onInput={(event) => setText(event.currentTarget.value)}
            onKeyDown={onFieldKey}
          />
          <Toggle
            label={SEARCH_COPY.matchCase}
            text="Aa"
            pressed={caseSensitive}
            onToggle={() => setCaseSensitive(!caseSensitive())}
          />
          <Toggle
            label={SEARCH_COPY.matchWholeWord}
            text="ab"
            pressed={wholeWord}
            onToggle={() => setWholeWord(!wholeWord())}
          />
          <Toggle
            label={SEARCH_COPY.useRegex}
            text=".*"
            pressed={regex}
            onToggle={() => setRegex(!regex())}
          />
        </div>
        <input
          type="text"
          class="search-glob"
          aria-label={SEARCH_COPY.filesToInclude}
          placeholder={SEARCH_COPY.filesToInclude}
          autocomplete="off"
          spellcheck={false}
          value={include()}
          onInput={(event) => setInclude(event.currentTarget.value)}
          onKeyDown={onFieldKey}
        />
        <input
          type="text"
          class="search-glob"
          aria-label={SEARCH_COPY.filesToExclude}
          placeholder={SEARCH_COPY.filesToExclude}
          autocomplete="off"
          spellcheck={false}
          value={exclude()}
          onInput={(event) => setExclude(event.currentTarget.value)}
          onKeyDown={onFieldKey}
        />
      </div>
      <p
        class="search-summary"
        classList={{ "is-error": status().kind === "invalid" || status().kind === "failed" }}
        data-testid="search-summary"
        aria-live="polite"
      >
        {summaryText(status(), results().length)}
      </p>
      <ul class="search-results">
        <For each={results()}>{(result) => <FileGroup result={result} onOpen={props.onOpen} />}</For>
      </ul>
    </aside>
  );
}
