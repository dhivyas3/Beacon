import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { progress } from '@/test/builders';
import { presentProgress, ScanProgress, useSmoothedEta } from './scan-progress';

const running = progress({
  phase: 'running',
  percent: 41,
  pagesFound: 214,
  pagesDone: 87,
  pagesTotal: 214,
  etaSeconds: 148,
});

describe('presentProgress', () => {
  it('queued: muted, no percentage, shows the queue position', () => {
    const view = presentProgress('queued', progress({ queuePosition: 2 }), null);
    expect(view).toMatchObject({
      aside: '2nd in queue',
      tone: 'muted',
      showPercent: false,
      indeterminate: false,
    });
    expect(presentProgress('queued', progress(), null).aside).toBe('Waiting in queue');
  });

  it('discovering: indeterminate with the number found so far and no time estimate', () => {
    const view = presentProgress('discovering', progress({ pagesFound: 143 }), null);
    expect(view).toMatchObject({ indeterminate: true, showPercent: false, aside: '' });
    expect(view.detail).toBe('Discovering pages, 143 found so far');
  });

  it('running: pages and a rounded, human time left', () => {
    const view = presentProgress('running', running, 148);
    expect(view.detail).toBe('87 of 214 pages');
    expect(view.aside).toBe('about 2 min left');
    expect(view.showPercent).toBe(true);
    expect(presentProgress('running', running, 20).aside).toBe('less than a minute left');
    expect(presentProgress('running', running, 4800).aside).toBe('about 1 hr 20 min left');
  });

  it('running: says Estimating… until there is enough data', () => {
    const early = progress({ ...running, estimating: true, etaSeconds: null, pagesDone: 3 });
    expect(presentProgress('running', early, null).aside).toBe('Estimating…');
  });

  it('running: switches to links once pages are done', () => {
    const links = progress({
      ...running,
      phase: 'checking_links',
      linksChecked: 310,
      linksTotal: 1240,
    });
    const view = presentProgress('running', links, 60);
    expect(view.phase).toBe('Verifying links');
    expect(view.detail).toBe('310 of 1,240 links');
  });

  it('completed: replaces the estimate with the actual duration', () => {
    const done = progress({
      phase: 'completed',
      percent: 100,
      pagesDone: 214,
      pagesTotal: 214,
      elapsedSeconds: 252,
    });
    const view = presentProgress('completed', done, null);
    expect(view.aside).toBe('Completed in 4 min 12 s');
    expect(view.tone).toBe('success');
  });

  it('failed and cancelled: freeze the bar in a muted colour', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const view = presentProgress(
        status,
        progress({ percent: 41, pagesDone: 87, pagesTotal: 214 }),
        null,
      );
      expect(view.tone).toBe('muted');
      expect(view.showPercent).toBe(true);
      expect(view.detail).toBe('87 of 214 pages');
    }
  });
});

describe('ScanProgress', () => {
  it('renders an accessible progress bar with the percentage beside it', () => {
    render(<ScanProgress status="running" progress={running} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '41');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('41%')).toBeInTheDocument();
    expect(screen.getByText('87 of 214 pages')).toBeInTheDocument();
    expect(screen.getByText('Checking pages')).toBeInTheDocument();
  });

  it('animates the fill between values with a 300 ms ease', () => {
    render(<ScanProgress status="running" progress={running} />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill).toHaveStyle({ width: '41%' });
    expect(fill.className).toContain('duration-300');
    expect(fill.className).toContain('ease-out');
  });

  it('uses an indeterminate bar with no value while discovering', () => {
    render(<ScanProgress status="discovering" progress={progress({ pagesFound: 12 })} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  it('shows an empty muted bar and the queue position while queued', () => {
    render(<ScanProgress status="queued" progress={progress({ queuePosition: 3 })} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('3rd in queue')).toBeInTheDocument();
  });

  it('shows the last value for a failed scan', () => {
    render(
      <ScanProgress
        status="failed"
        progress={progress({ percent: 41, pagesDone: 87, pagesTotal: 214 })}
      />,
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '41');
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('gives the large variant the bigger figure and the same information', () => {
    render(<ScanProgress status="running" progress={running} size="large" />);
    expect(screen.getByText('41%').className).toContain('text-2xl');
    expect(screen.getByText('87 of 214 pages')).toBeInTheDocument();
  });
});

describe('useSmoothedEta', () => {
  it('starts at the first estimate, then moves 30% of the way to each new one', () => {
    const { result, rerender } = renderHook<number | null, { eta: number | null }>(
      ({ eta }) => useSmoothedEta(eta),
      {
        initialProps: { eta: 100 },
      },
    );
    expect(result.current).toBe(100);
    act(() => rerender({ eta: 200 }));
    expect(result.current).toBe(130);
    act(() => rerender({ eta: 200 }));
    expect(result.current).toBe(130); // an unchanged estimate is not re-smoothed
    act(() => rerender({ eta: 60 }));
    expect(result.current).toBe(109);
  });

  it('forgets the smoothing when the estimate disappears', () => {
    const { result, rerender } = renderHook<number | null, { eta: number | null }>(
      ({ eta }) => useSmoothedEta(eta),
      {
        initialProps: { eta: 100 },
      },
    );
    act(() => rerender({ eta: null }));
    expect(result.current).toBeNull();
    act(() => rerender({ eta: 500 }));
    expect(result.current).toBe(500);
  });
});
