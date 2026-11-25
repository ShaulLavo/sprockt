// Lazily loaded workspace seeding and metadata updates.
// Opens only the Waffle filesystem worker (never Bun, bash-web, Ghostty or Singapore).
import { createRuntime, openIdleWorkspace } from "waffle";
import filesystemWorker from "waffle/browser/fs-worker?worker&url";
import { createFileService } from "../files/service";
import { PROJECT_ROOT, storageName } from "../workspace/paths";
import { BLANK_TEMPLATE, findTemplate, type TemplateId } from "./catalog";
import {
  createWorkspaceMeta,
  normalizeWorkspaceName,
  parseWorkspaceMeta,
  serializeWorkspaceMeta,
  WORKSPACE_META_DIR,
  WORKSPACE_META_PATH,
  type WorkspaceMeta,
} from "./workspace-meta";

const decoder = new TextDecoder();

function openFilesystemRuntime(id: string) {
  return createRuntime({
    filesystem: {
      mode: "fast",
      name: storageName(id),
      workerURL: new URL(filesystemWorker, location.origin),
      whenBusy: "takeover",
    },
  });
}

export async function seedWorkspace(
  id: string,
  templateId: TemplateId,
  customName?: string,
): Promise<WorkspaceMeta> {
  const template = findTemplate(templateId) ?? BLANK_TEMPLATE;
  const meta = createWorkspaceMeta({
    name: customName ?? template.defaultName,
    template: template.id,
  });
  const runtime = openFilesystemRuntime(id);
  const files = createFileService(runtime);
  try {
    await runtime.filesystem.mkdirp(PROJECT_ROOT);
    if (Object.keys(template.files).length > 0) {
      await files.writeMany(template.files);
    }
    await runtime.filesystem.mkdirp(WORKSPACE_META_DIR);
    await runtime.filesystem.writeFile(WORKSPACE_META_PATH, serializeWorkspaceMeta(meta));
    await runtime.filesystem.flush();
    return meta;
  } finally {
    files.dispose();
    await runtime.dispose();
  }
}

export type RenameResult =
  | { readonly status: "renamed"; readonly meta: WorkspaceMeta }
  | { readonly status: "busy" | "missing" | "invalid" };

export async function renameWorkspace(id: string, nextName: string): Promise<RenameResult> {
  const normalized = normalizeWorkspaceName(nextName);
  if (!normalized) return { status: "invalid" };

  const name = storageName(id);
  const idle = await openIdleWorkspace({ mode: "fast", name });
  if (idle === "busy" || idle === "missing") return { status: idle };

  let existing: WorkspaceMeta | undefined;
  try {
    const bytes = await idle.readFile(WORKSPACE_META_PATH);
    if (bytes) existing = parseWorkspaceMeta(decoder.decode(bytes));
  } finally {
    await idle.close();
  }

  const now = new Date().toISOString();
  const updated: WorkspaceMeta = existing
    ? { ...existing, name: normalized }
    : { name: normalized, template: "blank", created: now, lastOpened: now };

  const runtime = openFilesystemRuntime(id);
  try {
    await runtime.filesystem.mkdirp(WORKSPACE_META_DIR);
    await runtime.filesystem.writeFile(WORKSPACE_META_PATH, serializeWorkspaceMeta(updated));
    await runtime.filesystem.flush();
    return { status: "renamed", meta: updated };
  } finally {
    await runtime.dispose();
  }
}
