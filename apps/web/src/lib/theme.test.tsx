import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from '@/components/app-shell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider, useTheme } from './theme';

function withTheme({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe('theme', () => {
  it('follows the system setting by default', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('dark'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { result } = renderHook(() => useTheme(), { wrapper: withTheme });
    expect(result.current.preference).toBe('system');
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('remembers a manual choice and applies it', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: withTheme });
    act(() => result.current.setPreference('dark'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('qa-hub-theme')).toBe('dark');

    const again = renderHook(() => useTheme(), { wrapper: withTheme });
    expect(again.result.current.preference).toBe('dark');
  });

  it('cycles light, dark, system from the toggle button', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ThemeProvider>
          <ThemeToggle />
        </ThemeProvider>
      </TooltipProvider>,
    );
    const button = () => screen.getByRole('button', { name: /switch theme/i });
    expect(button()).toHaveAccessibleName('Theme: System. Switch theme');
    await user.click(button());
    expect(button()).toHaveAccessibleName('Theme: Light. Switch theme');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    await user.click(button());
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await user.click(button());
    expect(button()).toHaveAccessibleName('Theme: System. Switch theme');
  });

  it('still works when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTheme(), { wrapper: withTheme });
    act(() => result.current.setPreference('light'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    vi.restoreAllMocks();
  });
});
