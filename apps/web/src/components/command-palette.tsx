import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ApiClientError, api } from '@/api/client';
import { useWebsites } from '@/api/hooks';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { filterCommands, type Command } from '@/lib/commands';
import { useTheme } from '@/lib/theme';

/** Everything the palette can do, built from what is on screen and what websites exist. */
function useCommands(open: boolean, close: () => void): Command[] {
  const navigate = useNavigate();
  const client = useQueryClient();
  const theme = useTheme();
  const websites = useWebsites({}, open);

  const checkNow = useMutation({
    mutationFn: (id: string) => api.websites.checkNow(id),
    onSuccess: (scan) => {
      void client.invalidateQueries({ queryKey: ['websites'] });
      void client.invalidateQueries({ queryKey: ['scans'] });
      toast.success('Check started');
      void navigate(`/scans/${scan.id}`);
    },
    onError: (error) =>
      toast.error(error instanceof ApiClientError ? error.message : 'Could not start the check.'),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      client.clear();
      void navigate('/login', { replace: true });
      toast.success('You are signed out');
    },
  });

  return useMemo(() => {
    const go = (to: string) => () => {
      close();
      void navigate(to);
    };
    const commands: Command[] = [
      { id: 'go-overview', group: 'Go to', label: 'Overview', run: go('/') },
      { id: 'go-websites', group: 'Go to', label: 'Websites', run: go('/websites') },
      { id: 'go-scans', group: 'Go to', label: 'Scans', keywords: ['reports'], run: go('/scans') },
      {
        id: 'go-settings',
        group: 'Go to',
        label: 'Settings',
        keywords: ['keys', 'domains'],
        run: go('/settings'),
      },
      {
        id: 'add-website',
        group: 'Actions',
        label: 'Add website',
        keywords: ['register', 'new', 'monitor'],
        run: go('/websites/new'),
      },
      {
        id: 'one-off',
        group: 'Actions',
        label: 'Run a one-off scan',
        keywords: ['new scan', 'check a site'],
        run: go('/scans'),
      },
    ];
    for (const website of websites.data?.pages.flatMap((page) => page.items) ?? []) {
      commands.push(
        {
          id: `open-${website.id}`,
          group: 'Websites',
          label: `Open ${website.name}`,
          hint: website.hostname,
          run: go(`/websites/${website.id}`),
        },
        {
          id: `check-${website.id}`,
          group: 'Websites',
          label: `Check ${website.name} now`,
          hint: website.hostname,
          keywords: ['scan', 'run'],
          run: () => {
            close();
            checkNow.mutate(website.id);
          },
        },
      );
    }
    commands.push(
      {
        id: 'theme-light',
        group: 'Appearance',
        label: 'Use the light theme',
        run: () => {
          close();
          theme.setPreference('light');
        },
      },
      {
        id: 'theme-dark',
        group: 'Appearance',
        label: 'Use the dark theme',
        run: () => {
          close();
          theme.setPreference('dark');
        },
      },
      {
        id: 'theme-system',
        group: 'Appearance',
        label: 'Follow the system theme',
        run: () => {
          close();
          theme.setPreference('system');
        },
      },
      {
        id: 'sign-out',
        group: 'Account',
        label: 'Sign out',
        keywords: ['log out'],
        run: () => {
          close();
          logout.mutate();
        },
      },
    );
    return commands;
  }, [websites.data, navigate, close, theme, checkNow, logout]);
}

/**
 * Jump anywhere, or start something, from the keyboard. A combobox over a listbox: focus stays in
 * the input while the arrow keys move a highlighted option, which is announced by
 * `aria-activedescendant`.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const commands = useCommands(open, () => onOpenChange(false));
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Start fresh each time it opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const current = Math.min(active, Math.max(results.length - 1, 0));
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [current, results]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current + 1) % Math.max(results.length, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current - 1 + results.length) % Math.max(results.length, 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(results.length - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      results[current]?.run();
    }
  }

  let lastGroup = '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Command palette"
        description="Search for a page, a website or an action."
        hideTitle
        className="top-[16vh] max-w-xl -translate-y-0 p-0"
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-subtle" aria-hidden />
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? `${listId}-${current}` : undefined}
            aria-label="Search commands"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search pages, websites and actions"
            autoComplete="off"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent pr-8 text-sm text-fg placeholder:text-subtle focus:outline-none"
          />
        </div>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Commands"
          className="max-h-[50vh] overflow-y-auto p-2"
        >
          {results.map((command, index) => {
            const heading =
              command.group !== lastGroup && query.trim() === '' ? command.group : null;
            lastGroup = command.group;
            return (
              <li key={command.id} role="presentation">
                {heading ? (
                  <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-subtle">
                    {heading}
                  </p>
                ) : null}
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === current}
                  data-index={index}
                  onMouseMove={() => setActive(index)}
                  onClick={command.run}
                  className={cn(
                    'flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-2 py-2 text-sm',
                    index === current ? 'bg-accent-soft text-accent-text' : 'text-fg',
                  )}
                >
                  <span className="truncate">{command.label}</span>
                  {command.hint ? (
                    <span className="truncate font-mono text-xs text-subtle">{command.hint}</span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {results.length === 0 ? (
          <p role="status" className="px-4 pb-6 pt-2 text-center text-[13px] text-muted">
            Nothing matches “{query.trim()}”. Try a website name or a page such as settings.
          </p>
        ) : (
          <p className="sr-only" role="status">
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </p>
        )}
        <p className="border-t border-border px-4 py-2 text-xs text-subtle" aria-hidden>
          ↑ ↓ to move, Enter to choose, Esc to close
        </p>
      </DialogContent>
    </Dialog>
  );
}
