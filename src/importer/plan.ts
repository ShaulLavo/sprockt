// Turns unpacked files into what a new workspace needs: the file record FileService writes, and
// the install and dev-server plan the after-import hook runs.
import { decodeUtf8 } from "../lib/bytes";
import type { FileEntry } from "../lib/fs/types";
import type { Route } from "../app/routes";
import { detectProject, type ProjectDetection } from "./detect/detect";
import type { GitHubSource } from "./github/source";
import { isMetaPath, type ImportPlan } from "./metadata";

export type { ImportPlan };

/** Detection reads a handful of small text files; nothing else needs decoding. */
export function detectFromEntries(files: readonly FileEntry[]): ProjectDetection {
  const byPath = new Map(files.map((file) => [file.path, file.bytes]));
  return detectProject({
    paths: byPath.keys(),
    read: (path) => {
      const bytes = byPath.get(path);
      return bytes ? decodeUtf8(bytes) : undefined;
    },
  });
}

export function planFrom(detection: ProjectDetection): ImportPlan {
  return { install: detection.install, dev: detection.dev, port: detection.port };
}

/**
 * The record `FileService.writeMany` takes. An imported `.sprockt/` folder is dropped: the
 * workspace's own metadata goes there.
 */
export function fileRecord(files: readonly FileEntry[]): Record<string, Uint8Array> {
  return Object.fromEntries(
    files.filter((file) => !isMetaPath(file.path)).map((file) => [file.path, file.bytes]),
  );
}

/**
 * The importer's view of a `/github/...` route. The route splits the first segment after `tree/`
 * off as `branch`, but a branch can contain slashes, so the importer takes every segment and
 * resolves where the ref ends itself.
 */
export function sourceFromRoute(route: Extract<Route, { kind: "github" }>): GitHubSource {
  const tail = [route.branch ?? "", route.subdir ?? ""].filter((part) => part !== "").join("/");
  return {
    owner: route.owner,
    repo: route.repo,
    refAndPath: tail === "" ? [] : tail.split("/").filter((segment) => segment !== ""),
    target: "tree",
  };
}
