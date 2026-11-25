// Which document the editor shows, whether it has unsaved edits, and what happens to text that
// is not safely stored yet. No UI here: the pane feeds it events, the tests replay them.
//
// The rules: saving always targets the document on screen, never the file merely selected;
// every document keeps its own edit count for as long as the workspace is open, so a save
// that finishes late can only vouch for the edits it contained; a conflict belongs to its
// document; and text is recoverable until storage, not just memory, holds it.

/** Text of a file that storage does not hold yet. */
export interface Draft {
  readonly text: string;
  /** What storage held when this text was last in step with it; absent: no such file. */
  readonly baseText?: string | undefined;
}

export interface SaveRequest {
  readonly path: string;
  /** The edit count the saved text contains. */
  readonly generation: number;
  /** What the file is expected to hold right now. */
  readonly baseText: string | undefined;
}

/** A save found that the file changed on disk since the editor read it. */
export interface Conflict {
  readonly path: string;
  readonly diskText: string | undefined;
}

interface Entry {
  /** What the file holds as far as this tab knows, counting writes acknowledged from memory. */
  baseText: string | undefined;
  /** Edits made to this document since it was first opened. Never reset. */
  generation: number;
  /** The edit count of the last acknowledged write. */
  savedGeneration: number;
  /** What storage is known to hold, and the edit count that text contained. */
  durableBase: string | undefined;
  durableGeneration: number;
  /** The document's text while it is not on screen, when storage does not hold it yet. */
  text: string | undefined;
  conflict: { readonly diskText: string | undefined } | undefined;
}

export class Documents {
  private selectedPath: string | undefined;
  private shownPath: string | undefined;
  private readonly entries = new Map<string, Entry>();

  /** `recover` supplies text another tab left behind when it lost the workspace. */
  constructor(private readonly recover: (path: string) => Draft | undefined = () => undefined) {}

  private get shown(): Entry | undefined {
    return this.shownPath === undefined ? undefined : this.entries.get(this.shownPath);
  }

  get selected(): string | undefined {
    return this.selectedPath;
  }

  /** The path on screen. It trails `selected` while the newly selected file is being read. */
  get displayed(): string | undefined {
    return this.shownPath;
  }

  get dirty(): boolean {
    return this.shownPath !== undefined && this.hasUnsaved(this.shownPath);
  }

  /** The conflict of the document on screen. A conflict of another document waits for it. */
  get conflict(): Conflict | undefined {
    const pending = this.shown?.conflict;
    return pending && this.shownPath !== undefined ? { path: this.shownPath, ...pending } : undefined;
  }

  hasUnsaved(path: string): boolean {
    const entry = this.entries.get(path);
    return entry !== undefined && entry.generation > entry.savedGeneration;
  }

  /** Returns false when `path` is already selected: selecting it again changes nothing. */
  select(path: string): boolean {
    if (this.selectedPath === path) return false;
    this.selectedPath = path;
    return true;
  }

  private opened(path: string, diskText: string | undefined): Entry {
    const recovered = this.recover(path);
    // Recovered text is one unsaved edit on top of what its tab had read from storage.
    const entry: Entry = recovered
      ? {
          baseText: recovered.baseText,
          generation: 1,
          savedGeneration: 0,
          durableBase: recovered.baseText,
          durableGeneration: 0,
          text: recovered.text,
          conflict: undefined,
        }
      : {
          baseText: diskText,
          generation: 0,
          savedGeneration: 0,
          durableBase: diskText,
          durableGeneration: 0,
          text: undefined,
          conflict: undefined,
        };
    this.entries.set(path, entry);
    return entry;
  }

  /**
   * The read of `path` finished. Returns the text to put on screen, or undefined when the
   * selection moved on meanwhile and this read is stale. `currentText` is read only when the
   * document leaving the screen has text storage does not hold yet.
   */
  show(path: string, diskText: string | undefined, currentText: () => string): string | undefined {
    if (this.selectedPath !== path) return undefined;
    const leaving = this.shown;
    if (leaving && this.shownPath !== path) {
      leaving.text = leaving.generation > leaving.durableGeneration ? currentText() : undefined;
    }
    this.shownPath = path;
    const entry = this.entries.get(path) ?? this.opened(path, diskText);
    if (entry.generation > entry.savedGeneration) return entry.text ?? diskText ?? "";
    // No unsaved edits: the file is shown as storage has it now.
    entry.baseText = diskText;
    return diskText ?? "";
  }

  /**
   * The person changed the text of `path`. An edit reported after its file left the screen is
   * already part of that file's kept text and must not mark the file now on screen.
   */
  edited(path: string | undefined): void {
    const entry = this.shown;
    if (entry && this.shownPath === path) entry.generation += 1;
  }

  /** What a save started now has to write, or undefined when nothing is on screen. */
  beginSave(): SaveRequest | undefined {
    const entry = this.shown;
    if (!entry || this.shownPath === undefined) return undefined;
    return { path: this.shownPath, generation: entry.generation, baseText: entry.baseText };
  }

  /** The write for `request` was acknowledged with `text`. Storage may not hold it yet. */
  saved(request: SaveRequest, text: string): void {
    const entry = this.entries.get(request.path);
    // A write that finishes after a newer one of the same document has nothing to add.
    if (!entry || request.generation < entry.savedGeneration) return;
    entry.savedGeneration = request.generation;
    entry.baseText = text;
    entry.conflict = undefined;
    // Off screen and with no newer edits, the written text is what is kept for recovery.
    if (this.shownPath !== request.path && entry.generation === request.generation) entry.text = text;
  }

  /** Storage now holds the text written for `request`. */
  durable(request: SaveRequest, text: string): void {
    const entry = this.entries.get(request.path);
    if (!entry || request.generation < entry.durableGeneration) return;
    entry.durableGeneration = request.generation;
    entry.durableBase = text;
    if (this.shownPath !== request.path && entry.generation === request.generation) entry.text = undefined;
  }

  /** The save was refused: the file holds `diskText`, not what the editor last read. */
  conflicted(request: SaveRequest, diskText: string | undefined): void {
    const entry = this.entries.get(request.path);
    if (entry) entry.conflict = { diskText };
  }

  /** The person keeps the text on screen: its next save expects what is on disk now. */
  keepMine(): void {
    const entry = this.shown;
    if (!entry?.conflict) return;
    entry.baseText = entry.conflict.diskText;
    entry.conflict = undefined;
  }

  /** The person takes the text on disk for the document on screen. Returns that text. */
  takeTheirs(): string | undefined {
    const entry = this.shown;
    if (!entry?.conflict) return undefined;
    const { diskText } = entry.conflict;
    entry.conflict = undefined;
    entry.baseText = entry.durableBase = diskText;
    entry.savedGeneration = entry.durableGeneration = entry.generation;
    return diskText ?? "";
  }

  /**
   * Every text storage does not hold yet: unsaved edits, and writes acknowledged from memory
   * whose flush has not finished. This is what another tab needs if this one loses storage.
   */
  unsaved(currentText: () => string): Map<string, Draft> {
    const all = new Map<string, Draft>();
    for (const [path, entry] of this.entries) {
      if (entry.generation <= entry.durableGeneration) continue;
      const text = path === this.shownPath ? currentText() : entry.text;
      if (text !== undefined) all.set(path, { text, baseText: entry.durableBase });
    }
    return all;
  }
}
