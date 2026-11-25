// Turns what the user dropped or picked into upload items. Dropped folders need the (prefixed but
// universally shipped) FileSystemEntry API; a file picker with `webkitdirectory` reports each
// file's folder in `webkitRelativePath`.
import type { UploadItem } from "../files/service";

/** macOS and Windows litter folders with these; nobody wants them in a project. */
const JUNK = new Set([".DS_Store", "Thumbs.db"]);

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function directoryChildren(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const children: FileSystemEntry[] = [];
  // readEntries returns at most about 100 entries per call; an empty batch is the end.
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    const batch = await readEntries(reader);
    if (batch.length === 0) return children;
    children.push(...batch);
  }
}

async function collect(entry: FileSystemEntry, prefix: string, items: UploadItem[]): Promise<void> {
  if (JUNK.has(entry.name)) return;
  const path = prefix + entry.name;
  if (entry.isFile) {
    items.push({ path, data: await fileOf(entry as FileSystemFileEntry) });
    return;
  }
  items.push({ path });
  const children = await directoryChildren(entry as FileSystemDirectoryEntry);
  await Promise.all(children.map((child) => collect(child, `${path}/`, items)));
}

/**
 * The files and folders of a drop. Call it inside the drop event: the browser empties the
 * transfer once the event handler returns, so the entries are taken before anything is awaited.
 */
export function itemsFromDrop(transfer: DataTransfer): Promise<UploadItem[]> {
  const entries = Array.from(transfer.items, (item) => item.webkitGetAsEntry());
  const plainFiles = Array.from(transfer.files);
  const items: UploadItem[] = [];
  const known = entries.filter((entry) => entry !== null);
  if (known.length === 0) {
    return Promise.resolve(plainFiles.map((file) => ({ path: file.name, data: file })));
  }
  const walked = Promise.all(known.map((entry) => collect(entry, "", items))).then(() => items);
  // Some transfers (a synthetic drop, a few mobile browsers) list entries that cannot be read.
  // When every dropped item is a plain file, the File objects taken above are just as good.
  const allFiles = known.every((entry) => entry.isFile);
  return allFiles ? walked.catch(() => plainFiles.map((file) => ({ path: file.name, data: file }))) : walked;
}

/** The files of a file picker; with `webkitdirectory` they keep their folder structure. */
export function itemsFromPicker(files: FileList | null): UploadItem[] {
  return Array.from(files ?? [], (file) => ({
    path: file.webkitRelativePath || file.name,
    data: file,
  })).filter((item) => !JUNK.has(item.path.slice(item.path.lastIndexOf("/") + 1)));
}
