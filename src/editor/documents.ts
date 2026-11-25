// Which document the editor shows, whether it has unsaved edits, and where unsaved text goes
// when another file is shown. No UI here: the pane feeds it events, the tests replay them.
//
// The rules: saving always targets the document on screen, never the file merely selected;
// "dirty" is cleared only for the edits a finished save actually contained; and unsaved text is
// never dropped by switching files.

/** Unsaved text of a file that is not on screen. */
export interface Draft {
  readonly text: string;
  /** What the file held when this text was last in step with it; absent: it did not exist. */
  readonly baseText?: string | undefined;
}

export interface SaveRequest {
  readonly path: string;
  /** The edit count the saved text will contain. */
  readonly generation: number;
  /** What the file is expected to hold right now. */
  readonly baseText: string | undefined;
}

/** A save found that the file changed on disk since the editor read it. */
export interface Conflict {
  readonly path: string;
  readonly diskText: string | undefined;
}

interface Displayed {
  readonly path: string;
  baseText: string | undefined;
  generation: number;
  savedGeneration: number;
}

export class Documents {
  private selectedPath: string | undefined;
  private shown: Displayed | undefined;
  private pendingConflict: Conflict | undefined;
  private readonly drafts = new Map<string, Draft>();

  /** `recover` supplies text another tab left behind when it lost the workspace. */
  constructor(private readonly recover: (path: string) => Draft | undefined = () => undefined) {}

  get selected(): string | undefined {
    return this.selectedPath;
  }

  /** The path on screen. It trails `selected` while the newly selected file is being read. */
  get displayed(): string | undefined {
    return this.shown?.path;
  }

  get dirty(): boolean {
    return this.shown !== undefined && this.shown.generation > this.shown.savedGeneration;
  }

  get conflict(): Conflict | undefined {
    return this.pendingConflict;
  }

  hasUnsaved(path: string): boolean {
    return this.shown?.path === path ? this.dirty : this.drafts.has(path);
  }

  /** Returns false when `path` is already selected: selecting it again changes nothing. */
  select(path: string): boolean {
    if (this.selectedPath === path) return false;
    this.selectedPath = path;
    return true;
  }

  /**
   * The read of `path` finished. Returns the text to put on screen, or undefined when the
   * selection moved on meanwhile and this read is stale. `currentText` is read only when the
   * document leaving the screen has unsaved edits to keep.
   */
  show(path: string, diskText: string | undefined, currentText: () => string): string | undefined {
    if (this.selectedPath !== path) return undefined;
    if (this.shown && this.dirty) {
      this.drafts.set(this.shown.path, { text: currentText(), baseText: this.shown.baseText });
    }
    const draft = this.drafts.get(path) ?? this.recover(path);
    this.drafts.delete(path);
    this.pendingConflict = undefined;
    this.shown = draft
      ? { path, baseText: draft.baseText, generation: 1, savedGeneration: 0 }
      : { path, baseText: diskText, generation: 0, savedGeneration: 0 };
    return draft ? draft.text : (diskText ?? "");
  }

  /**
   * The person changed the text of `path`. An edit reported after its file left the screen is
   * already part of that file's draft and must not mark the file now on screen.
   */
  edited(path: string | undefined): void {
    if (this.shown && this.shown.path === path) this.shown.generation += 1;
  }

  /** What a save started now has to write, or undefined when nothing is on screen. */
  beginSave(): SaveRequest | undefined {
    if (!this.shown) return undefined;
    return { path: this.shown.path, generation: this.shown.generation, baseText: this.shown.baseText };
  }

  /** The save for `request` reached the file with `text`. */
  saved(request: SaveRequest, text: string): void {
    if (this.pendingConflict?.path === request.path) this.pendingConflict = undefined;
    if (this.shown?.path === request.path) {
      this.shown.baseText = text;
      this.shown.savedGeneration = Math.max(this.shown.savedGeneration, request.generation);
      return;
    }
    // The file left the screen while it was being saved: its draft is done unless it moved on.
    const draft = this.drafts.get(request.path);
    if (!draft) return;
    if (draft.text === text) this.drafts.delete(request.path);
    else this.drafts.set(request.path, { text: draft.text, baseText: text });
  }

  /** The save was refused: the file holds `diskText`, not what the editor last read. */
  conflicted(request: SaveRequest, diskText: string | undefined): void {
    this.pendingConflict = { path: request.path, diskText };
  }

  /** The person chose to keep their text: the next save expects what is on disk now. */
  keepMine(): void {
    if (this.shown && this.pendingConflict?.path === this.shown.path)
      this.shown.baseText = this.pendingConflict.diskText;
    this.pendingConflict = undefined;
  }

  /** The person chose the text on disk. Returns it, for the pane to put on screen. */
  takeTheirs(): string | undefined {
    const conflict = this.pendingConflict;
    if (!conflict || this.shown?.path !== conflict.path) return undefined;
    this.pendingConflict = undefined;
    this.shown = { path: conflict.path, baseText: conflict.diskText, generation: 0, savedGeneration: 0 };
    return conflict.diskText ?? "";
  }

  /** Every unsaved text, on screen or not, to hand to another tab. */
  unsaved(currentText: () => string): Record<string, Draft> {
    const all = Object.fromEntries(this.drafts);
    if (this.shown && this.dirty)
      all[this.shown.path] = { text: currentText(), baseText: this.shown.baseText };
    return all;
  }
}
