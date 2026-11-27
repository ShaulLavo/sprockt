import { useCallback, useEffect, useRef, useState } from "react";
import { StrokeIcon } from "@shaulavo/workbench-icons/react";
import {
  ancestorsOf,
  baseName,
  FileTreeModel,
  targetDirectory,
  topLevelPaths,
  type TreeEntryRow,
} from "@shaulavo/workbench-tree";
import { FileTreeView, type FileTreeViewHandle } from "@shaulavo/workbench-tree/react";
import type { EditorStore } from "../editor/store";
import { DestinationExistsError, FolderGoneError } from "../files/errors";
import type { UploadItem } from "../files/service";
import { useValue } from "../lib/react";
import { workspaceName } from "../workspace/hint";
import { useWorkspace } from "../workspace/session";
import { createAutoOpener } from "./auto-open";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { copy, fill } from "./copy";
import { downloadBlob } from "./download";
import { itemsFromDrop, itemsFromPicker } from "./upload";
import { createWaffleFileSystemAdapter, rebaseExpandedPaths } from "./waffle-adapter";
import "./explorer.css";

const AUTO_OPEN_ENTRIES = 300;
const AUTO_OPEN_CONCURRENCY = 4;
const NOTICE_MS = 6000;

const FILE_PATH = "M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z";
const FOLDER_PATH =
  "M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z";
const TRAY_PATH = "M4.5 15v3.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V15";

const TOOLBAR_ICONS = {
  filePlus: [FILE_PATH, "M13.5 3.5v5h5M12 11.5v6M9 14.5h6"],
  folderPlus: [FOLDER_PATH, "M12 10.5v5M9.5 13h5"],
  upload: ["M12 15V4.5M7.5 9 12 4.5 16.5 9", TRAY_PATH],
  download: ["M12 4.5V15M7.5 10.5 12 15l4.5-4.5", TRAY_PATH],
  collapse: ["m7 10 5-5 5 5M7 19l5-5 5 5"],
} as const;

function ToolbarIcon(props: { readonly name: keyof typeof TOOLBAR_ICONS }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      {TOOLBAR_ICONS[props.name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly row: TreeEntryRow | null;
}

function readExpanded(key: string): string[] | undefined {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return undefined;
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return undefined;
  }
}

function writeExpanded(key: string, paths: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(paths));
  } catch {
    // Ignore storage failures in private browsing.
  }
}

function readSavedScroll(key: string): number {
  try {
    const raw = sessionStorage.getItem(key);
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeSavedScroll(key: string, top: number): void {
  try {
    sessionStorage.setItem(key, String(Math.round(top)));
  } catch {
    // Ignore storage failures in private browsing.
  }
}

function formatOperationError(error: unknown): string {
  if (error instanceof DestinationExistsError) {
    return fill(copy.notices.moveExists, { name: baseName(error.path) });
  }
  if (error instanceof FolderGoneError) {
    return fill(copy.notices.folderGone, { path: error.path });
  }
  return fill(copy.notices.failed, {
    message: error instanceof Error ? error.message : String(error),
  });
}

export function Explorer(props: { readonly store: EditorStore }) {
  const { store } = props;
  const workspace = useWorkspace();
  const { files } = workspace;
  const expandedKey = `sprockt:${workspace.id}:explorer-expanded`;
  const scrollKey = `sprockt:${workspace.id}:explorer-scroll`;

  const handleRef = useRef<FileTreeViewHandle | null>(null);
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  const folderPickerRef = useRef<HTMLInputElement | null>(null);
  const uploadDirRef = useRef("");
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoOpenActiveRef = useRef(readExpanded(expandedKey) === undefined);

  const [initialScrollTop] = useState(() => readSavedScroll(scrollKey));
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<"upload" | "zip" | undefined>(undefined);
  const [menu, setMenu] = useState<MenuState | undefined>(undefined);
  const [deletingPaths, setDeletingPaths] = useState<readonly string[] | undefined>(undefined);
  const [rootListed, setRootListed] = useState(false);
  const [rowCount, setRowCount] = useState(0);
  const [filterQuery, setFilterQuery] = useState("");

  const [model] = useState(() => {
    const saved = readExpanded(expandedKey);
    return new FileTreeModel({
      compactFolders: true,
      initialExpanded: saved,
    });
  });

  const say = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(undefined), NOTICE_MS);
  }, []);

  const persistExpanded = useCallback(() => {
    writeExpanded(expandedKey, model.getExpandedPaths());
  }, [expandedKey, model]);

  const [waffle] = useState(() => {
    let opener: ReturnType<typeof createAutoOpener> | undefined;
    const handle = createWaffleFileSystemAdapter({
      workspaceId: workspace.id,
      files,
      store,
      onDirectoryListed(dirPath, entries) {
        if (dirPath === "") setRootListed(true);
        if (autoOpenActiveRef.current) opener?.offer(dirPath, entries);
      },
      onPathsMoved(moves) {
        const rebased = rebaseExpandedPaths(model.getExpandedPaths(), moves);
        model.collapseAll();
        for (const dir of rebased) model.setExpanded(dir, true);
        writeExpanded(expandedKey, rebased);
      },
    });
    opener = createAutoOpener({
      limit: AUTO_OPEN_ENTRIES,
      concurrency: AUTO_OPEN_CONCURRENCY,
      list: (directory) => files.readdir(directory),
      open(directory, listing) {
        if (!autoOpenActiveRef.current) return;
        handle.seedDirectory(directory, listing);
        model.setExpanded(directory, true);
        writeExpanded(expandedKey, model.getExpandedPaths());
      },
    });
    return { ...handle, stopAutoOpen: () => opener?.stop() };
  });

  useEffect(() => {
    folderPickerRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => {
    const sync = () => {
      const snap = model.getSnapshot();
      setRowCount(snap.rows.length);
      setFilterQuery(snap.filter);
    };
    sync();
    return model.subscribe(sync);
  }, [model]);

  useEffect(() => {
    return () => {
      clearTimeout(noticeTimerRef.current);
      waffle.stopAutoOpen();
      waffle.dispose();
    };
  }, [waffle]);

  const activePath = useValue(store.active);
  const writable = useValue(files.writable);
  const dirtyPaths = useValue(() => {
    const dirty = new Set<string>();
    const dirtyDirs = new Set<string>();
    for (const tab of store.tabs()) {
      if (!store.hasUnsaved(tab.path)) continue;
      dirty.add(tab.path);
      for (const anc of ancestorsOf(tab.path)) dirtyDirs.add(anc);
    }
    return { dirty, dirtyDirs };
  });

  const stopAutoOpen = useCallback(() => {
    if (!autoOpenActiveRef.current) return;
    autoOpenActiveRef.current = false;
    waffle.stopAutoOpen();
  }, [waffle]);

  const currentTargetDirectory = useCallback((): string => {
    const snap = model.getSnapshot();
    const target = snap.focusedPath ?? Array.from(snap.selected).at(-1);
    if (!target) return "";
    const kind = model.getEntryKind(target);
    return kind ? targetDirectory(target, kind) : "";
  }, [model]);

  const upload = useCallback(
    async (items: readonly UploadItem[], directory: string) => {
      if (items.length === 0 || !files.writable()) return;
      stopAutoOpen();
      setBusy("upload");
      try {
        const result = await files.upload(items, directory);
        if (directory) {
          model.setExpanded(directory, true);
          persistExpanded();
        }
        if (result.skipped > 0) {
          say(
            result.skipped === 1
              ? copy.notices.skippedOne
              : fill(copy.notices.skipped, { count: result.skipped }),
          );
        }
      } catch (error) {
        say(formatOperationError(error));
      } finally {
        setBusy(undefined);
      }
    },
    [files, model, persistExpanded, say, stopAutoOpen],
  );

  const pickUpload = useCallback((directory: string, folder: boolean) => {
    uploadDirRef.current = directory;
    const input = folder ? folderPickerRef.current : filePickerRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  }, []);

  const handlePickerChange = useCallback(
    (input: HTMLInputElement) => {
      const items = itemsFromPicker(input.files);
      input.value = "";
      void upload(items, uploadDirRef.current);
    },
    [upload],
  );

  const handleDownloadZip = useCallback(async () => {
    setBusy("zip");
    try {
      const blob = await files.exportZip();
      downloadBlob(blob, `${workspaceName(workspace.id)}.zip`);
    } catch (error) {
      say(fill(copy.notices.zipFailed, { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(undefined);
    }
  }, [files, say, workspace.id]);

  const handleExternalDrop = useCallback(
    (dirPath: string, dataTransfer: DataTransfer) => {
      // Must extract DataTransfer items synchronously before awaiting.
      const itemsPromise = itemsFromDrop(dataTransfer);
      void itemsPromise.then((items) => upload(items, dirPath));
    },
    [upload],
  );

  const beginCreate = useCallback(
    (kind: "file" | "directory", parentOverride?: string) => {
      stopAutoOpen();
      const parent = parentOverride ?? currentTargetDirectory();
      handleRef.current?.startCreate(parent, kind);
    },
    [currentTargetDirectory, stopAutoOpen],
  );

  const confirmDelete = useCallback(async () => {
    const paths = deletingPaths;
    setDeletingPaths(undefined);
    if (!paths || paths.length === 0) return;
    try {
      await waffle.removePaths(paths);
    } catch (error) {
      say(formatOperationError(error));
    }
  }, [deletingPaths, say, waffle]);

  const buildMenuItems = (row: TreeEntryRow | null): MenuItem[] => {
    const directory = row ? targetDirectory(row.path, row.kind) : "";
    const download: MenuItem = {
      label: copy.actions.download,
      testId: "menu-download",
      run: () => void handleDownloadZip(),
    };
    if (!writable) return row === null ? [download] : [];
    const base: MenuItem[] = [
      { label: copy.actions.newFile, testId: "menu-new-file", run: () => beginCreate("file", directory) },
      {
        label: copy.actions.newFolder,
        testId: "menu-new-folder",
        run: () => beginCreate("directory", directory),
      },
      {
        label: copy.actions.uploadFiles,
        testId: "menu-upload-files",
        run: () => pickUpload(directory, false),
      },
      {
        label: copy.actions.uploadFolder,
        testId: "menu-upload-folder",
        run: () => pickUpload(directory, true),
      },
    ];
    if (row === null) return base.concat(download);
    const selected = model.getSnapshot().selected;
    const deleteList = selected.has(row.path) ? topLevelPaths(Array.from(selected)) : [row.path];
    return base.concat(
      {
        label: copy.actions.rename,
        hint: "F2",
        testId: "menu-rename",
        run: () => {
          stopAutoOpen();
          handleRef.current?.startRename(row.path);
        },
      },
      {
        label: copy.actions.delete,
        hint: "Del",
        danger: true,
        testId: "menu-delete",
        run: () => setDeletingPaths(deleteList),
      },
    );
  };

  const confirmation = (() => {
    if (!deletingPaths || deletingPaths.length === 0) return undefined;
    if (deletingPaths.length > 1) {
      return {
        ...copy.confirmMany,
        title: fill(copy.confirmMany.title, { count: deletingPaths.length }),
      };
    }
    const first = deletingPaths[0] ?? "";
    const kind = model.getEntryKind(first);
    const text = kind === "directory" ? copy.confirmFolder : copy.confirmFile;
    return { ...text, title: fill(text.title, { name: baseName(first) }) };
  })();

  const openMenuItems = menu ? buildMenuItems(menu.row) : [];

  return (
    <section className="pane explorer-pane" aria-label={copy.title}>
      <header className="pane-header explorer-head">
        <span className="pane-title">{copy.title}</span>
        <span className="pane-actions">
          <button
            type="button"
            data-testid="new-file"
            aria-label={copy.actions.newFile}
            title={copy.actions.newFile}
            disabled={!writable}
            onClick={() => beginCreate("file")}
          >
            <ToolbarIcon name="filePlus" />
          </button>
          <button
            type="button"
            data-testid="new-folder"
            aria-label={copy.actions.newFolder}
            title={copy.actions.newFolder}
            disabled={!writable}
            onClick={() => beginCreate("directory")}
          >
            <ToolbarIcon name="folderPlus" />
          </button>
          <button
            type="button"
            data-testid="upload-files"
            aria-label={copy.actions.uploadFiles}
            title={copy.actions.uploadFiles}
            disabled={!writable || busy === "upload"}
            onClick={() => pickUpload(currentTargetDirectory(), false)}
          >
            <ToolbarIcon name="upload" />
          </button>
          <button
            type="button"
            data-testid="download-zip"
            aria-label={copy.actions.download}
            title={copy.actions.download}
            disabled={busy === "zip"}
            onClick={() => void handleDownloadZip()}
          >
            <ToolbarIcon name="download" />
          </button>
          <button
            type="button"
            data-testid="collapse-all"
            aria-label={copy.actions.collapseAll}
            title={copy.actions.collapseAll}
            onClick={() => {
              stopAutoOpen();
              handleRef.current?.collapseAll();
              persistExpanded();
            }}
          >
            <ToolbarIcon name="collapse" />
          </button>
        </span>
      </header>
      <span id="tree-unsaved" hidden>
        {copy.unsaved}
      </span>
      <input
        ref={filePickerRef}
        type="file"
        multiple
        hidden
        data-testid="upload-input"
        onChange={(event) => handlePickerChange(event.currentTarget)}
      />
      <input
        ref={folderPickerRef}
        type="file"
        hidden
        data-testid="upload-folder-input"
        onChange={(event) => handlePickerChange(event.currentTarget)}
      />
      <div
        className="tree-root"
        onClick={() => {
          model.clearSelection();
          model.setFocusedPath(undefined);
        }}
      >
        <StrokeIcon name="chevron" className="ico tree-root-chevron" />
        <span>{workspaceName(workspace.id)}</span>
      </div>
      <div className="explorer-tree-host" data-testid="file-tree">
        <FileTreeView
          model={model}
          adapter={waffle.adapter}
          handleRef={handleRef}
          label={copy.title}
          showFilter={false}
          filterPlaceholder={copy.filterPlaceholder}
          readOnly={!writable}
          initialScrollTop={initialScrollTop}
          onScrollTopChange={(top) => writeSavedScroll(scrollKey, top)}
          activePath={activePath ?? null}
          renderRowDecoration={(row) => {
            const isDirty =
              row.kind === "file"
                ? dirtyPaths.dirty.has(row.path)
                : dirtyPaths.dirtyDirs.has(row.path) ||
                  (row.segments?.some((seg) => dirtyPaths.dirtyDirs.has(seg.path)) ?? false);
            return isDirty ? <span className="dirty" aria-describedby="tree-unsaved" /> : null;
          }}
          onOpenFile={(path) => {
            store.open(path);
          }}
          onExpandChange={(_dirPath, _expanded) => {
            stopAutoOpen();
            persistExpanded();
          }}
          onRequestContextMenu={(row, anchor) => {
            if (anchor instanceof HTMLElement) {
              const rect = anchor.getBoundingClientRect();
              setMenu({ x: rect.left + 12, y: rect.bottom, row });
              return;
            }
            setMenu({ x: anchor.x, y: anchor.y, row });
          }}
          onRequestDelete={(paths) => {
            stopAutoOpen();
            setDeletingPaths(paths);
          }}
          onMove={async (moves) => {
            stopAutoOpen();
            await waffle.movePaths(moves);
          }}
          onExternalDrop={handleExternalDrop}
          onError={(_message, error) => say(formatOperationError(error))}
        />
        {rootListed && rowCount === 0 ? (
          <p className="tree-empty" data-testid="tree-empty">
            {filterQuery.trim() ? copy.filterEmpty : copy.empty}
          </p>
        ) : null}
      </div>
      {notice ? (
        <p className="tree-notice" role="status" data-testid="tree-notice">
          {notice}
        </p>
      ) : null}
      {menu && openMenuItems.length > 0 ? (
        <ContextMenu
          key={`${menu.x}:${menu.y}:${menu.row?.path ?? ""}`}
          x={menu.x}
          y={menu.y}
          label={copy.actions.menu}
          items={openMenuItems}
          onClose={(escaped) => {
            const origin = menu.row?.path ?? model.getSnapshot().focusedPath;
            setMenu(undefined);
            if (escaped && origin) handleRef.current?.focusPath(origin);
          }}
        />
      ) : null}
      {confirmation ? (
        <ConfirmDialog
          title={confirmation.title}
          body={confirmation.body}
          confirm={confirmation.confirm}
          cancel={confirmation.cancel}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeletingPaths(undefined)}
        />
      ) : null}
    </section>
  );
}
