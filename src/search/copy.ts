// Search strings, synced with copy/ui.json.
export const SEARCH_COPY = {
  search: "Search",
  quickOpen: "Open file by name",
  searchWorkspace: "Search across files",
  filesToInclude: "Files to include",
  filesToExclude: "Files to exclude",
  noFileResults: "No matching files",
  noSearchResults: "No matching text",
  closeSearch: "Close search",
  matchCase: "Match case",
  matchWholeWord: "Match whole word",
  useRegex: "Use regular expression",
  searching: "Searching",
  resultOneInOne: "1 result in 1 file",
  resultManyInOne: "{matches} results in 1 file",
  resultCount: "{matches} results in {files} files",
  truncated: "Showing first {matches} results",
  searchFailed: "Search failed: {message}",
} as const;

export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => String(values[key] ?? whole));
}
