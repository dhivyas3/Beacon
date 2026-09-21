import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor, Moon, Search, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { useSession } from '@/api/hooks';
import { CommandPalette } from '@/components/command-palette';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { useTheme } from '@/lib/theme';

const SHORTCUT =
  typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K';

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path
        d="M10.6 15.4a7.8 7.8 0 0 1 10.8 0"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M6.7 11.6a13.2 13.2 0 0 1 18.6 0"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="16" cy="21.4" r="2.9" fill="#fff" />
    </svg>
  );
}

const THEME_ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const THEME_LABEL = { light: 'Light', dark: 'Dark', system: 'System' } as const;

export function ThemeToggle() {
  const { preference, cycle } = useTheme();
  const Icon = THEME_ICON[preference];
  return (
    <Tooltip content={`Theme: ${THEME_LABEL[preference]}`}>
      <Button
        variant="ghost"
        size="icon"
        onClick={cycle}
        aria-label={`Theme: ${THEME_LABEL[preference]}. Switch theme`}
      >
        <Icon className="size-4" aria-hidden />
      </Button>
    </Tooltip>
  );
}

function UserMenu() {
  const session = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      client.clear();
      void navigate('/login', { replace: true });
      toast.success('You are signed out');
    },
  });
  const user = session.data?.user;
  if (!user) return null;
  const initial = (user.name || user.email).charAt(0).toUpperCase();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent-text transition-colors hover:bg-border"
          aria-label={`Account menu for ${user.name}`}
        >
          {initial}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <p className="truncate text-sm font-semibold text-fg">{user.name}</p>
        <p className="truncate text-[13px] text-muted">{user.email}</p>
        <p className="mt-1 text-xs capitalize text-subtle">{user.role}</p>
        <Button
          className="mt-4 w-full"
          size="sm"
          loading={logout.isPending}
          onClick={() => logout.mutate()}
        >
          <LogOut className="size-3.5" aria-hidden />
          Sign out
        </Button>
      </PopoverContent>
    </Popover>
  );
}

const navLink = ({ isActive }: { isActive: boolean }) =>
  cn(
    'shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150',
    isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg',
  );

/** Header, page container and the routes below it. */
export function AppShell() {
  const client = useQueryClient();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Ctrl+K or Cmd+K opens the palette from anywhere, and closes it again.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-4 px-4 sm:px-6">
          <NavLink
            to="/"
            className="flex items-center gap-2 rounded-md text-[15px] font-semibold text-fg"
            onClick={() => void client.invalidateQueries({ queryKey: ['scans'] })}
          >
            <Logo />
            <span className="sr-only sm:not-sr-only">Beacon</span>
          </NavLink>
          <nav className="scroll-x flex min-w-0 items-center gap-1" aria-label="Main">
            <NavLink to="/" end className={navLink}>
              Overview
            </NavLink>
            <NavLink to="/websites" className={navLink}>
              Websites
            </NavLink>
            <NavLink to="/scans" end className={navLink}>
              Scans
            </NavLink>
            <NavLink to="/settings" className={navLink}>
              Settings
            </NavLink>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              className="text-muted sm:min-w-44 sm:justify-between"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search and run commands"
              aria-keyshortcuts="Control+K Meta+K"
            >
              <span className="flex items-center gap-2">
                <Search className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">Search</span>
              </span>
              <kbd className="hidden rounded border border-border-strong px-1.5 font-sans text-[11px] text-subtle sm:inline">
                {SHORTCUT}
              </kbd>
            </Button>
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <main id="main" className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
