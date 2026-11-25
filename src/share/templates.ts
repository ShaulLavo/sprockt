// Where share links find a template's files. A link carries only the changes since its template,
// so decoding needs the template itself. The templates slice registers its catalog here; until
// it does, every link is made against the blank template and carries all of its files.
import type { FileEntry } from "../lib/fs/types";

export type TemplateFiles = (
  id: string,
) => readonly FileEntry[] | undefined | Promise<readonly FileEntry[] | undefined>;

/** The template with no files: a link against it carries the whole workspace. */
export const BLANK_TEMPLATE = "blank";

let resolver: TemplateFiles = () => undefined;

export function registerTemplateFiles(source: TemplateFiles): void {
  resolver = source;
}

/** The files of template `id`, or `undefined` when no registered catalog knows it. */
export async function templateFiles(id: string): Promise<readonly FileEntry[] | undefined> {
  if (id === BLANK_TEMPLATE) return [];
  return resolver(id);
}
