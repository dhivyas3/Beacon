export interface Command {
  id: string;
  /** What the person reads and what is matched first. */
  label: string;
  /** A second line, such as a hostname. Also matched. */
  hint?: string;
  /** Extra words that should find this command. */
  keywords?: string[];
  group: string;
  run: () => void;
}

/** Lower is better. Null means no match. Every word typed has to match somewhere. */
function score(command: Command, words: string[]): number | null {
  const label = command.label.toLowerCase();
  const rest = [command.hint ?? '', ...(command.keywords ?? [])].join(' ').toLowerCase();
  let total = 0;
  for (const word of words) {
    if (label.startsWith(word)) total += 0;
    else if (label.split(' ').some((part) => part.startsWith(word))) total += 1;
    else if (label.includes(word)) total += 2;
    else if (rest.includes(word)) total += 3;
    else return null;
  }
  return total;
}

/**
 * The commands that match what was typed, best first. Nothing typed keeps the given order, which
 * is how the list is grouped. Ties keep the given order too, so results do not shuffle.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(' ').filter(Boolean);
  if (words.length === 0) return commands;
  return commands
    .map((command, index) => ({ command, index, rank: score(command, words) }))
    .filter(
      (entry): entry is { command: Command; index: number; rank: number } => entry.rank !== null,
    )
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command);
}
