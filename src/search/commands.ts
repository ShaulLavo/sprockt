// Commands in quick open, next to files. `>` shows only commands, as in other editors. Without it a
// command shows above the files once the query starts one of its words ("sav" finds Save), so a
// phone with no keyboard shortcuts reaches them by typing a few letters.

/** A command quick open can run. */
export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  /** The keyboard shortcut as shown to the person, such as "⌘S". */
  readonly shortcut?: string;
  run(): void;
}

/** Shorter queries name files far more often than commands. */
const MIN_QUERY = 3;

const PREFIX = ">";

/** Whether the query asks for commands only. */
export const commandsOnly = (query: string) => query.trimStart().startsWith(PREFIX);

function startsAWord(label: string, query: string): boolean {
  const lower = label.toLowerCase();
  if (lower.startsWith(query)) return true;
  return lower.split(/\s+/).some((word) => word.startsWith(query));
}

/** The commands a query finds, in the order they were given. */
export function matchCommands(query: string, commands: readonly PaletteCommand[]): PaletteCommand[] {
  const only = commandsOnly(query);
  const text = (only ? query.trimStart().slice(PREFIX.length) : query).trim().toLowerCase();
  if (only && text === "") return commands.slice();
  if (!only && text.length < MIN_QUERY) return [];
  return commands.filter((command) => startsAWord(command.label, text));
}
