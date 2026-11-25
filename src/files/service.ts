// The one door between the UI and a workspace's files. Paths are project-relative.
import { createSignal, type Accessor } from "solid-js";
import type { Runtime } from "waffle";
import { PROJECT_ROOT, projectRelative } from "../workspace/paths";
import { isHeavyPath } from "./tree";
import { watchProject } from "./watch";

export type SaveState = "saved" | "saving" | "failed";

export interface FileService {
  /** Project files, without node_modules and .git. */
  list(): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  readBytes(path: string): Promise<Uint8Array | undefined>;
  /** Creates missing parent directories. */
  write(path: string, content: string | Uint8Array): Promise<void>;
  /** Writes a whole file set, such as a template or an imported repository. */
  writeMany(files: Readonly<Record<string, string | Uint8Array>>): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Removes a file or a directory with everything in it. */
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Changes whenever the project's files may have changed; read it to re-run a listing. */
  readonly revision: Accessor<number>;
  /** Whether everything written so far has reached IndexedDB. */
  readonly saveState: Accessor<SaveState>;
  dispose(): void;
}

/** How long changes are gathered before the explorer is told: an install touches many files. */
const COALESCE_MS = 50;

const absolute = (path: string) => (path ? `${PROJECT_ROOT}/${path}` : PROJECT_ROOT);
const parent = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

export function createFileService(runtime: Runtime): FileService {
  const filesystem = runtime.filesystem;
  const [revision, setRevision] = createSignal(0);
  const [saveState, setSaveState] = createSignal<SaveState>("saved");
  const decoder = new TextDecoder();
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Waffle acknowledges a write from memory. A flush is what makes it survive a reload, so every
  // change starts one and the indicator stays on "saving" until the last of them lands.
  async function persist(): Promise<void> {
    pending += 1;
    setSaveState("saving");
    const failed = await filesystem.flush().then(
      () => false,
      () => true,
    );
    pending -= 1;
    if (failed) setSaveState("failed");
    else if (pending === 0) setSaveState("saved");
  }

  function announce(): void {
    timer = undefined;
    setRevision((value) => value + 1);
    void persist();
  }

  /** Every source of change lands here: our own writes and the filesystem watcher. */
  function changed(): void {
    timer ??= setTimeout(announce, COALESCE_MS);
  }

  async function write(path: string, content: string | Uint8Array): Promise<void> {
    await filesystem.mkdirp(absolute(parent(path)));
    await filesystem.writeFile(absolute(path), content);
  }

  const stopWatching = watchProject(runtime, changed);

  return {
    revision,
    saveState,
    async list() {
      const files = await filesystem.listFiles(PROJECT_ROOT);
      return files.flatMap((file) => {
        const relative = projectRelative(file);
        return relative && !isHeavyPath(relative) ? [relative] : [];
      });
    },
    readBytes: (path) => filesystem.readFile(absolute(path)),
    async read(path) {
      const bytes = await filesystem.readFile(absolute(path));
      return bytes && decoder.decode(bytes);
    },
    async write(path, content) {
      await write(path, content);
      changed();
    },
    async writeMany(files) {
      await Promise.all(Object.entries(files).map(([path, content]) => write(path, content)));
      changed();
    },
    async mkdir(path) {
      await filesystem.mkdirp(absolute(path));
      changed();
    },
    async remove(path) {
      await filesystem.remove(absolute(path));
      changed();
    },
    async move(from, to) {
      await filesystem.mkdirp(absolute(parent(to)));
      await filesystem.move(absolute(from), absolute(to));
      changed();
    },
    dispose() {
      clearTimeout(timer);
      stopWatching();
    },
  };
}
