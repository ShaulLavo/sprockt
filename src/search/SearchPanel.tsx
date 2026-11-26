// Cmd/Ctrl+Shift+F: search across the project's files. Typing re-runs the search after a short
// pause; results stream in grouped by file, and a click opens the file at the match.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { FileService } from "../files/service";
import { useValue } from "../lib/react";
import type { Accessor } from "../lib/reactive";
import { fill, SEARCH_COPY } from "./copy";
import { ChevronIcon, CloseIcon, FileIcon, SearchIcon } from "./icons";
import { searchProject, type FileMatches, type ProjectSearchSummary } from "./project";
import type { LineMatch } from "./text";
import { createWorkerMatcher, type WorkerMatcher } from "./worker-matcher";
import "./search.css";

const DEBOUNCE_MS = 200;

type Status = ProjectSearchSummary | { readonly kind: "idle" } | { readonly kind: "running" };

export interface SearchPanelProps {
  readonly files: Pick<FileService, "list" | "readBytes" | "size">;
  readonly onOpen: (path: string, location: { line: number; column: number }) => void;
  readonly onClose: () => void;
  /** Each change focuses the query field. */
  readonly focusRequest: Accessor<number>;
}

function Toggle(props: { label: string; text: string; pressed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="search-toggle"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      onClick={() => props.onToggle()}
    >
      {props.text}
    </button>
  );
}

function MatchRow(props: { match: LineMatch; onOpen: () => void }) {
  const { match } = props;
  // Leading indentation is noise in a result list; trim it and keep the match position right.
  const indent = Math.min(match.preview.length - match.preview.trimStart().length, match.previewStart);
  const start = match.previewStart - indent;
  const text = match.preview.slice(indent);
  return (
    <li>
      <button
        type="button"
        className="search-match"
        data-testid="search-result"
        onClick={() => props.onOpen()}
      >
        <span className="search-match-line">{match.line}</span>
        <span className="search-match-text">
          {text.slice(0, start)}
          <mark>{text.slice(start, start + match.length)}</mark>
          {text.slice(start + match.length)}
        </span>
      </button>
    </li>
  );
}

function FileGroup(props: { result: FileMatches; onOpen: SearchPanelProps["onOpen"] }) {
  const { result } = props;
  const [open, setOpen] = useState(true);
  const name = result.path.slice(result.path.lastIndexOf("/") + 1);
  const dir = result.path.slice(0, Math.max(result.path.lastIndexOf("/"), 0));
  return (
    <li className="search-file" data-testid="search-file" data-path={result.path}>
      <button type="button" className="search-file-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronIcon class={open ? "is-open" : ""} />
        <FileIcon path={result.path} />
        <span className="search-file-name">{name}</span>
        <span className="search-file-dir">{dir}</span>
        <span className="search-file-count">{result.matches.length}</span>
      </button>
      {open ? (
        <ul className="search-matches">
          {result.matches.map((match, index) => (
            <MatchRow
              key={index}
              match={match}
              onOpen={() => props.onOpen(result.path, { line: match.line, column: match.column })}
            />
          ))}
        </ul>
      ) : null}
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

async function finish(
  lifetime: AbortController,
  search: Promise<ProjectSearchSummary>,
  flush: () => void,
  matcher: WorkerMatcher,
  setStatus: (status: Status) => void,
) {
  const summary = await search
    .catch((error: unknown): ProjectSearchSummary => ({ kind: "failed", message: String(error) }))
    .finally(() => matcher.dispose());
  if (lifetime.signal.aborted) return;
  flush();
  setStatus(summary);
}

export function SearchPanel(props: SearchPanelProps) {
  const [text, setText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [results, setResults] = useState<readonly FileMatches[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const focusRequest = useValue(props.focusRequest);
  const input = useRef<HTMLInputElement>(null);
  const running = useRef<AbortController>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const typed = useRef(false);

  function run(): void {
    clearTimeout(timer.current);
    running.current?.abort();
    const lifetime = new AbortController();
    running.current = lifetime;
    setResults([]);
    if (!text) return void setStatus({ kind: "idle" });
    setStatus({ kind: "running" });
    // Files arrive faster than frames; gather them and paint once per frame.
    let batch: FileMatches[] = [];
    const flush = () => {
      if (lifetime.signal.aborted || batch.length === 0) return;
      const landed = batch;
      batch = [];
      setResults((current) => current.concat(landed));
    };
    // Matching runs in a worker of this run's own; aborting the run terminates it.
    const matcher = createWorkerMatcher(lifetime.signal);
    const request = {
      query: { text, caseSensitive, wholeWord, regex },
      include,
      exclude,
      signal: lifetime.signal,
      match: matcher.match,
      onFile: (result: FileMatches) => {
        if (batch.length === 0) requestAnimationFrame(flush);
        batch.push(result);
      },
    };
    void finish(lifetime, searchProject(props.files, request), flush, matcher, setStatus);
  }

  // Not on mount: only a change to the query or its options searches again.
  useEffect(() => {
    if (!typed.current) {
      typed.current = true;
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(run, DEBOUNCE_MS);
    // `run` reads this render's query, which is what these dependencies cover.
  }, [text, caseSensitive, wholeWord, regex, include, exclude]);

  useEffect(() => {
    queueMicrotask(() => input.current?.select());
  }, [focusRequest]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      running.current?.abort();
    },
    [],
  );

  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") run();
    if (event.key === "Escape") props.onClose();
  };

  const failed = status.kind === "invalid" || status.kind === "failed";

  return (
    <aside className="search-panel" aria-label={SEARCH_COPY.search} data-testid="search-panel">
      <header className="search-head">
        <span className="search-title">{SEARCH_COPY.search}</span>
        <button
          type="button"
          className="search-close"
          aria-label={SEARCH_COPY.closeSearch}
          onClick={() => props.onClose()}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="search-fields">
        <div className="search-query">
          <SearchIcon />
          <input
            ref={input}
            type="text"
            aria-label={SEARCH_COPY.searchWorkspace}
            placeholder={SEARCH_COPY.searchWorkspace}
            autoComplete="off"
            spellCheck={false}
            data-testid="search-input"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={onFieldKey}
          />
          <Toggle
            label={SEARCH_COPY.matchCase}
            text="Aa"
            pressed={caseSensitive}
            onToggle={() => setCaseSensitive(!caseSensitive)}
          />
          <Toggle
            label={SEARCH_COPY.matchWholeWord}
            text="ab"
            pressed={wholeWord}
            onToggle={() => setWholeWord(!wholeWord)}
          />
          <Toggle label={SEARCH_COPY.useRegex} text=".*" pressed={regex} onToggle={() => setRegex(!regex)} />
        </div>
        <input
          type="text"
          className="search-glob"
          aria-label={SEARCH_COPY.filesToInclude}
          placeholder={SEARCH_COPY.filesToInclude}
          autoComplete="off"
          spellCheck={false}
          value={include}
          onChange={(event) => setInclude(event.currentTarget.value)}
          onKeyDown={onFieldKey}
        />
        <input
          type="text"
          className="search-glob"
          aria-label={SEARCH_COPY.filesToExclude}
          placeholder={SEARCH_COPY.filesToExclude}
          autoComplete="off"
          spellCheck={false}
          value={exclude}
          onChange={(event) => setExclude(event.currentTarget.value)}
          onKeyDown={onFieldKey}
        />
      </div>
      <p
        className={failed ? "search-summary is-error" : "search-summary"}
        data-testid="search-summary"
        aria-live="polite"
      >
        {summaryText(status, results.length)}
      </p>
      <ul className="search-results">
        {results.map((result) => (
          <FileGroup key={result.path} result={result} onOpen={props.onOpen} />
        ))}
      </ul>
    </aside>
  );
}
