import { withWorkspaceMetaLock } from "../hint";
import { INCOMPLETE, readMetaFile, writeMetaFile, type ImportPlan, type MetaFilesystem } from "../metadata";

interface FirstOpenWorkspace {
  readonly id: string;
  readonly filesystem: MetaFilesystem;
  readonly signal: AbortSignal;
}

export function runFirstOpenPlan(
  { id, filesystem, signal }: FirstOpenWorkspace,
  run: (plan: ImportPlan) => unknown,
): Promise<void> {
  return withWorkspaceMetaLock(
    id,
    async () => {
      const meta = await readMetaFile(filesystem);
      if (!meta?.pendingImport || meta.state === INCOMPLETE || signal.aborted) return;
      const { pendingImport, ...rest } = meta;
      await Promise.all([run(pendingImport), writeMetaFile(filesystem, rest)]);
    },
    signal,
  );
}
