import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keys } from '@/api/hooks';
import { detail, historyItem, issue, pageOf, progress, session, settings } from '@/test/builders';
import { fakeApi } from '@/test/fake-api';
import { renderApp } from '@/test/render';

const ID = 'scn_000000000001';
const location = () => screen.getByTestId('location').textContent;

type Routes = Record<string, (request: never) => unknown>;

function routes(extra: Routes = {}) {
  return {
    'GET /auth/me': () => session(),
    'GET /settings': () => settings(),
    'GET /scans': () => pageOf([]),
    'GET /scans/:id': () => detail({ id: ID }),
    'GET /scans/:id/pages': () => pageOf([]),
    'GET /scans/:id/issues': () => pageOf([]),
    'GET /scans/:id/fixed': () => ({ items: [] }),
    'GET /websites/:id/history': () =>
      pageOf([
        historyItem({ runNumber: 8, healthScore: 90 }),
        historyItem({ runNumber: 7, healthScore: 84 }),
      ]),
    ...extra,
  };
}

const websiteScan = () =>
  detail({
    id: ID,
    runNumber: 8,
    website: { id: 'web_a', name: 'Example Estates' },
    triggeredByType: 'scheduled',
    triggeredBy: null,
    pageSelectionMode: 'random_sample',
  });

describe('the report of a website check', () => {
  it('names the website in a breadcrumb and does not call it a one-off scan', async () => {
    fakeApi(routes({ 'GET /scans/:id': () => websiteScan() }));
    renderApp(`/scans/${ID}`);

    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Websites' })).toHaveAttribute(
      'href',
      '/websites',
    );
    expect(within(nav).getByRole('link', { name: 'Example Estates' })).toHaveAttribute(
      'href',
      '/websites/web_a',
    );
    expect(within(nav).getByText('Check #8')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('One-off scan')).not.toBeInTheDocument();
    expect(screen.getByText(/Scheduled/)).toBeInTheDocument();
  });

  it('draws the trend from the website history and checks the website again', async () => {
    const api = fakeApi(
      routes({
        'GET /scans/:id': () => websiteScan(),
        'POST /websites/:id/check-now': () => ({
          status: 202,
          body: {
            id: 'scn_next',
            status: 'queued',
            statusUrl: 'http://qa.test/api/v1/scans/scn_next',
            reportUrl: 'http://qa.test/scans/scn_next',
          },
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp(`/scans/${ID}`);

    expect(await screen.findByText('Health score over time')).toBeInTheDocument();
    expect(api.callsTo('GET', '/websites/web_a/history').length).toBeGreaterThan(0);
    // The one-off history is not asked for.
    expect(
      api.calls.filter((call) => call.path === '/scans' && call.query.get('hostname')),
    ).toHaveLength(0);

    api.on('GET /scans/:id', () => detail({ id: 'scn_next', status: 'queued' }));
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(location()).toBe('/scans/scn_next'));
    expect(api.callsTo('POST', '/websites/web_a/check-now')).toHaveLength(1);
    expect(api.callsTo('POST', '/scans')).toHaveLength(0);
  });
});

describe('the report of a one-off scan', () => {
  it('says it is a one-off scan and that no email is sent', async () => {
    fakeApi(routes());
    renderApp(`/scans/${ID}`);
    expect(await screen.findByText('One-off scan')).toBeInTheDocument();
    expect(screen.getByText(/no email report is sent/)).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Scans' })).toHaveAttribute(
      'href',
      '/scans',
    );
    expect(screen.getByRole('button', { name: 'Re-scan' })).toBeInTheDocument();
  });
});

describe('exports', () => {
  it('offers CSV and PDF downloads for a finished scan', async () => {
    fakeApi(routes());
    renderApp(`/scans/${ID}`);
    const csv = await screen.findByRole('link', { name: 'Export CSV' });
    expect(csv).toHaveAttribute('href', `/api/v1/scans/${ID}/export.csv`);
    expect(csv).toHaveAttribute('download');
    expect(screen.getByRole('link', { name: 'Export PDF' })).toHaveAttribute(
      'href',
      `/api/v1/scans/${ID}/export.pdf`,
    );
  });

  it('does not offer them while the scan is still running', async () => {
    fakeApi(
      routes({
        'GET /scans/:id': () =>
          detail({
            id: ID,
            status: 'running',
            finishedAt: null,
            progress: progress({ phase: 'running', percent: 10, pagesDone: 1, pagesTotal: 10 }),
          }),
      }),
    );
    renderApp(`/scans/${ID}`);
    await screen.findByText('Scan in progress, results incomplete');
    expect(screen.queryByRole('link', { name: 'Export CSV' })).not.toBeInTheDocument();
  });
});

describe('fixed since the last check', () => {
  const withFixed = (overrides: Parameters<typeof detail>[0] = {}) =>
    detail({
      id: ID,
      fixedIssueCount: 2,
      previousScan: {
        id: 'scn_prev',
        runNumber: 7,
        healthScore: 80,
        finishedAt: '2026-08-01T06:00:00.000Z',
      },
      ...overrides,
    });

  it('lists the problems that are gone', async () => {
    fakeApi(
      routes({
        'GET /scans/:id': () => withFixed(),
        'GET /scans/:id/fixed': () => ({
          items: [
            {
              fingerprint: 'fp-a',
              checkType: 'images',
              severity: 'critical',
              message: 'Image failed to load (HTTP 404).',
              affectedPages: 3,
            },
            {
              fingerprint: 'fp-b',
              checkType: 'seo',
              severity: 'warning',
              message: 'Page has no meta description.',
              affectedPages: 1,
            },
          ],
        }),
      }),
    );
    renderApp(`/scans/${ID}`);

    expect(await screen.findByText('Fixed since the last check')).toBeInTheDocument();
    expect(await screen.findByText('Image failed to load (HTTP 404).')).toBeInTheDocument();
    expect(screen.getByText(/Images · was on 3 pages/)).toBeInTheDocument();
    expect(screen.getByText(/SEO · was on 1 page$/)).toBeInTheDocument();
    expect(screen.getByText(/2 problems found in run #7 are gone/)).toBeInTheDocument();
  });

  it('explains that a sample only counts pages checked both times', async () => {
    fakeApi(routes({ 'GET /scans/:id': () => withFixed({ pageSelectionMode: 'random_sample' }) }));
    renderApp(`/scans/${ID}`);
    expect(await screen.findByText(/Only pages checked both times count/)).toBeInTheDocument();
  });

  it('does not ask for the list, or show a card, when nothing was fixed', async () => {
    const api = fakeApi(routes({ 'GET /scans/:id': () => detail({ id: ID, fixedIssueCount: 0 }) }));
    renderApp(`/scans/${ID}`);
    await screen.findByText('One-off scan');
    expect(screen.queryByText('Fixed since the last check')).not.toBeInTheDocument();
    expect(api.callsTo('GET', `/scans/${ID}/fixed`)).toHaveLength(0);
  });
});

// ---- Live events ------------------------------------------------------------------------------

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

const runningDetail = () =>
  detail({
    id: ID,
    status: 'running',
    finishedAt: null,
    progress: progress({ phase: 'running', percent: 20, pagesDone: 2, pagesTotal: 10 }),
    summary: { healthScore: null, pages: 10, critical: 0, warnings: 0, passed: 0 },
    checkResults: [],
  });

describe('following a running scan live', () => {
  afterEach(() => {
    FakeEventSource.instances = [];
  });

  it('opens an event stream for a running scan, and not for a finished one', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    fakeApi(routes());
    renderApp(`/scans/${ID}`);
    await screen.findByText('One-off scan');
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('shows progress, issues and completion as they arrive, without polling', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const api = fakeApi(
      routes({
        'GET /scans/:id': () => runningDetail(),
        'GET /scans/:id/issues': () => pageOf([]),
      }),
    );
    const { client } = renderApp(`/scans/${ID}`);
    await screen.findByText('Scan in progress, results incomplete');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0] as FakeEventSource;
    expect(source.url).toBe(`/api/v1/scans/${ID}/events`);
    expect(source.init?.withCredentials).toBe(true);

    act(() => source.onopen?.());
    expect(client.getQueryData(keys.stream(ID))).toEqual({ connected: true });

    act(() =>
      source.emit('progress', {
        scanId: ID,
        status: 'running',
        progress: progress({ phase: 'running', percent: 55, pagesDone: 6, pagesTotal: 10 }),
        summary: { healthScore: null, pages: 10, critical: 1, warnings: 0, passed: 0 },
      }),
    );
    expect(await screen.findByText('55%')).toBeInTheDocument();

    act(() => source.emit('issue', issue({ id: 'iss_live', message: 'Found while streaming' })));
    expect(await screen.findByText('Found while streaming')).toBeInTheDocument();

    const before = api.callsTo('GET', `/scans/${ID}`).length;
    api.on('GET /scans/:id', () => detail({ id: ID }));
    act(() =>
      source.emit('done', {
        scanId: ID,
        status: 'completed',
        progress: progress({ phase: 'completed', percent: 100 }),
        summary: { healthScore: 88, pages: 10, critical: 1, warnings: 0, passed: 9 },
      }),
    );
    expect(source.closed).toBe(true);
    await waitFor(() => expect(api.callsTo('GET', `/scans/${ID}`).length).toBeGreaterThan(before));
    expect(await screen.findByRole('link', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('keeps the stream open when the last progress event says the scan finished, so done still arrives', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const api = fakeApi(routes({ 'GET /scans/:id': () => runningDetail() }));
    renderApp(`/scans/${ID}`);
    await screen.findByText('Scan in progress, results incomplete');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0] as FakeEventSource;
    const finished = {
      scanId: ID,
      status: 'completed',
      progress: progress({ phase: 'completed', percent: 100 }),
      summary: { healthScore: 88, pages: 10, critical: 1, warnings: 0, passed: 9 },
    };

    // The server sends the final progress and then done, back to back.
    api.on('GET /scans/:id', () => detail({ id: ID }));
    const before = api.callsTo('GET', `/scans/${ID}`).length;
    act(() => source.emit('progress', finished));
    // The full scan is loaded, with its per-check results, not patched into the cache.
    await waitFor(() => expect(api.callsTo('GET', `/scans/${ID}`).length).toBeGreaterThan(before));
    expect(await screen.findByText('Issues by check')).toBeInTheDocument();
    act(() => source.emit('done', finished));
    expect(source.closed).toBe(true);
  });

  it('goes back to polling when the stream drops', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    fakeApi(routes({ 'GET /scans/:id': () => runningDetail() }));
    const { client } = renderApp(`/scans/${ID}`);
    await screen.findByText('Scan in progress, results incomplete');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0] as FakeEventSource;

    act(() => source.onopen?.());
    expect(client.getQueryData(keys.stream(ID))).toEqual({ connected: true });
    act(() => source.onerror?.());
    expect(client.getQueryData(keys.stream(ID))).toEqual({ connected: false });
  });

  it('closes the stream when leaving the page', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    fakeApi(routes({ 'GET /scans/:id': () => runningDetail() }));
    const { unmount } = renderApp(`/scans/${ID}`);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    unmount();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});
