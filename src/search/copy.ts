// Search strings. The first group is copied from the copywriter's ui.json; the second group are
// functional placeholders the copywriter has not written yet (listed in the slice 3 report).
export const SEARCH_COPY = {
  search: "Search",
  quickOpen: "Open file by name",
  searchWorkspace: "Search across files",
  filesToInclude: "Files to include",
  filesToExclude: "Files to exclude",
  noFileResults: "No matching files",
  noSearchResults: "No matching text",

  // Placeholders.
  closeSearch: "Close search",
  matchCase: "Match case",
  matchWholeWord: "Match whole word",
  useRegex: "Use regular expression",
  searching: "Searching",
  resultCount: "{matches} results in {files} files",
  truncated: "Showing the first {matches} results",
  searchFailed: "Search stopped: {message}",
} as const;

export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => String(values[key] ?? whole));
}
