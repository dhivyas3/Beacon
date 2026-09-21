import { describe, expect, it } from 'vitest';
import { filterCommands, type Command } from './commands';

const make = (label: string, extra: Partial<Command> = {}): Command => ({
  id: label,
  label,
  group: 'Go to',
  run: () => undefined,
  ...extra,
});

const commands = [
  make('Overview'),
  make('Websites'),
  make('Scans'),
  make('Open Example Estates', { hint: 'www.example-estates.co.uk' }),
  make('Check Example Estates now', { hint: 'www.example-estates.co.uk', keywords: ['scan'] }),
  make('Add website', { keywords: ['register', 'new'] }),
];

const labels = (list: Command[]) => list.map((command) => command.label);

describe('filterCommands', () => {
  it('keeps every command, in order, when nothing is typed', () => {
    expect(filterCommands(commands, '  ')).toEqual(commands);
  });

  it('matches the start of the label first, then a word in it, then the rest', () => {
    expect(labels(filterCommands(commands, 'sc'))).toEqual(['Scans', 'Check Example Estates now']);
    expect(labels(filterCommands(commands, 'est'))).toEqual([
      'Open Example Estates',
      'Check Example Estates now',
    ]);
  });

  it('finds a command by its hint or keywords', () => {
    expect(labels(filterCommands(commands, 'co.uk'))).toEqual([
      'Open Example Estates',
      'Check Example Estates now',
    ]);
    expect(labels(filterCommands(commands, 'register'))).toEqual(['Add website']);
  });

  it('needs every word to match, in any order', () => {
    expect(labels(filterCommands(commands, 'estates check'))).toEqual([
      'Check Example Estates now',
    ]);
    expect(filterCommands(commands, 'estates zzz')).toEqual([]);
  });

  it('is not case sensitive', () => {
    expect(labels(filterCommands(commands, 'WEB'))).toEqual(['Websites', 'Add website']);
  });
});
