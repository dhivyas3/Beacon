import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, fakeApi, type FakeRequest } from '@/test/fake-api';
import {
  detail,
  group,
  issue,
  pageOf,
  progress,
  scan,
  scanPage,
  session,
  settings,
} from '@/test/builders';
import { renderApp } from '@/test/render';

const ID = 'scn_000000000001';
const location = () => screen.getByTestId('location').textContent;

interface Options {
  scan?: ReturnType<typeof detail>;
  pages?: ReturnType<typeof scanPage>[];
  issues?: ReturnType<typeof issue>[];
  groups?: ReturnType<typeof group>[];
  feed?: ReturnType<typeof issue>[];
  history?: ReturnType<typeof scan>[];
}

function routes(options: Options = {}) {
  return {
    'GET /auth/me': () => session(),
    'GET /settings': () => settings(),
    'GET /scans': () => pageOf(options.history ?? []),
    [`GET /scans/:id`]: () => options.scan ?? detail({ id: ID }),
    'GET /scans/:id/pages': () => pageOf(options.pages ?? []),
    'GET /scans/:id/issues': (request: FakeRequest) => {
      if (request.query.get('groupBy') === 'fingerprint') return pageOf(options.groups ?? []);
      if (request.query.get('sort') === 'newest') return pageOf(options.feed ?? []);
      return pageOf(options.issues ?? []);
    },
  };
}

const runningScan = () =>
  detail({
    id: ID,
    hostname: 'shop.example.com',
    url: 'https://shop.example.com/',
    status: 'running',
    finishedAt: null,
    progress: progress({
      phase: 'running',
      percent: 41,
      pagesFound: 214,
      pagesDone: 87,
      pagesTotal: 214,
      pagesPerMinute: 52,
      elapsedSeconds: 101,
      etaSeconds: 148,
      estimatedFinishAt: '2026-09-18T10:46:30.000Z',
    }),
    summary: { healthScore: null, pages: 214, critical: 6, warnings: 14, passed: 0 },
    checkResults: [],
  });

describe('a scan in progress', () => {
  it('shows a big progress figure, throughput, and a clear "results incomplete" banner', async () => {
    fakeApi(routes({ scan: runningScan() }));
    renderApp(`/scans/${ID}`);

    expect(await screen.findByText('Scan in progress, results incomplete')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '41');
    expect(screen.getByText('41%').className).toContain('text-2xl');
    expect(screen.getByText('87 of 214 pages')).toBeInTheDocument();
    expect(screen.getByText('Pages per minute').nextElementSibling).toHaveTextContent('52');
    expect(screen.getByText('Elapsed').nextElementSibling).toHaveTextContent('1 min 41 s');
    expect(screen.getByText('Estimated finish')).toBeInTheDocument();
    expect(
      screen.getByText('Found so far', { selector: 'p' }).nextElementSibling,
    ).toHaveTextContent('6 critical, 14 warnings');
    expect(screen.getByRole('heading', { name: 'shop.example.com' })).toBeInTheDocument();
  });

  it('puts the percentage in the browser tab title so it can be watched from another tab', async () => {
    fakeApi(routes({ scan: runningScan() }));
    renderApp(`/scans/${ID}`);
    await screen.findByText('Scan in progress, results incomplete');
    expect(document.title).toBe('41% · shop.example.com');
  });

  it('lists issues as they are found, newest first', async () => {
    const api = fakeApi(
      routes({
        scan: runningScan(),
        feed: [
          issue({
            message: 'Image failed to load (HTTP 404).',
            pageUrl: 'https://shop.example.com/products/oak',
          }),
          issue({
            severity: 'warning',
            message: 'Image has no alt attribute.',
            pageUrl: 'https://shop.example.com/about',
          }),
        ],
      }),
    );
    renderApp(`/scans/${ID}`);
    expect(await screen.findByText('Image failed to load (HTTP 404).')).toBeInTheDocument();
    expect(screen.getByText('/products/oak')).toBeInTheDocument();
    expect(screen.getByText('Image has no alt attribute.')).toBeInTheDocument();
    const request = api
      .callsTo('GET', `/scans/${ID}/issues`)
      .find((call) => call.query.get('sort') === 'newest');
    expect(request?.query.get('state')).toBe('open');
  });

  it('says nothing has been found yet', async () => {
    fakeApi(routes({ scan: runningScan(), feed: [] }));
    renderApp(`/scans/${ID}`);
    expect(await screen.findByText(/Nothing found yet/)).toBeInTheDocument();
  });

  it('cancels after asking for confirmation', async () => {
    const api = fakeApi({
      ...routes({ scan: runningScan() }),
      'POST /scans/:id/cancel': () => scan({ id: ID, status: 'cancelled' }),
    });
    const user = userEvent.setup();
    renderApp(`/scans/${ID}`);
    await user.click(await screen.findByRole('button', { name: 'Cancel scan' }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancel this scan?' });
    expect(api.callsTo('POST', `/scans/${ID}/cancel`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel scan' }));
    await waitFor(() => expect(api.callsTo('POST', `/scans/${ID}/cancel`)).toHaveLength(1));
    expect(await screen.findByText('Scan cancelled')).toBeInTheDocument();
  });

  it('keeps running when the dialog is dismissed', async () => {
    const api = fakeApi({
      ...routes({ scan: runningScan() }),
      'POST /scans/:id/cancel': () => scan(),
    });
    const user = userEvent.setup();
    renderApp(`/scans/${ID}`);
    await user.click(await screen.findByRole('button', { name: 'Cancel scan' }));
    await user.click(await screen.findByRole('button', { name: 'Keep running' }));
    expect(api.callsTo('POST', `/scans/${ID}/cancel`)).toHaveLength(0);
  });

  it('shows the queue position of a scan that has not started', async () => {
    fakeApi(
      routes({
        scan: detail({
          id: ID,
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          progress: progress({ queuePosition: 2 }),
          checkResults: [],
        }),
      }),
    );
    renderApp(`/scans/${ID}`);
    expect(await screen.findByText('2nd in queue')).toBeInTheDocument();
  });
});

const completed = () =>
  detail({
    id: ID,
    hostname: 'www.example.com',
    runNumber: 7,
    previousScan: {
      id: 'scn_prev',
      runNumber: 6,
      healthScore: 78,
      finishedAt: '2026-09-17T10:00:00.000Z',
    },
    scoreChange: 4,
    fixedIssueCount: 3,
  });

describe('the report', () => {
  it('shows the four summary figures and how the score changed', async () => {
    fakeApi(routes({ scan: completed() }));
    renderApp(`/scans/${ID}`);
    const score = (await screen.findByText('Health score', { selector: 'p' })).closest(
      'div',
    ) as HTMLElement;
    expect(within(score).getByText('82')).toBeInTheDocument();
    expect(within(score).getByText('Fair')).toBeInTheDocument();
    expect(within(score).getByText('+4 since last scan')).toBeInTheDocument();
    expect(within(score).getByText('Compared with run #6 · 3 issues fixed')).toBeInTheDocument();

    expect(screen.getByText('Pages scanned').nextElementSibling).toHaveTextContent('20');
    expect(screen.getByText('12 without issues')).toBeInTheDocument();
    expect(screen.getByText('Critical', { selector: 'p' }).nextElementSibling).toHaveTextContent(
      '3',
    );
    expect(screen.getByText('Warnings', { selector: 'p' }).nextElementSibling).toHaveTextContent(
      '11',
    );
  });

  it('explains how the health score is calculated', async () => {
    const user = userEvent.setup();
    fakeApi(routes({ scan: completed() }));
    renderApp(`/scans/${ID}`);
    const help = await screen.findByRole('button', { name: 'How the health score is calculated' });
    await user.hover(help);
    expect(
      (await screen.findAllByText(/costs 5 points and each warning costs 1/))[0],
    ).toBeInTheDocument();
  });

  it('draws the score trend from earlier completed scans, with a table alternative', async () => {
    fakeApi(
      routes({
        scan: completed(),
        history: [
          scan({
            runNumber: 7,
            summary: { healthScore: 82, pages: 20, critical: 3, warnings: 11, passed: 12 },
          }),
          scan({
            runNumber: 6,
            summary: { healthScore: 78, pages: 20, critical: 4, warnings: 12, passed: 11 },
          }),
          scan({
            runNumber: 5,
            summary: { healthScore: 71, pages: 20, critical: 6, warnings: 14, passed: 9 },
          }),
        ],
      }),
    );
    renderApp(`/scans/${ID}`);
    expect(await screen.findByText('Health score over time')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Health score across 3 scans, most recent 82 out of 100/ }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText(/#7 \(this scan\)/)).toBeInTheDocument();
    expect(within(rows[3] as HTMLElement).getByText('71')).toBeInTheDocument();
  });

  it('leaves out the trend when there is only one completed scan', async () => {
    fakeApi(routes({ scan: completed(), history: [scan({ runNumber: 7 })] }));
    renderApp(`/scans/${ID}`);
    await screen.findByText('Issues by check');
    expect(screen.queryByText('Health score over time')).not.toBeInTheDocument();
  });

  it('shows every check that ran, including the ones that passed', async () => {
    fakeApi(routes({ scan: completed() }));
    renderApp(`/scans/${ID}`);
    const chips = (await screen.findByText('Issues by check')).closest('section') as HTMLElement;
    expect(within(chips).getByRole('button', { name: /All checks\s*3/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(chips).getByRole('button', { name: /Images\s*2/ })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: /Links\s*Passed/ })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: /Page health\s*1/ })).toBeInTheDocument();
  });

  it('filters the list when a check chip is chosen, and clears it when chosen again', async () => {
    const api = fakeApi(routes({ scan: completed(), pages: [scanPage()] }));
    const user = userEvent.setup();
    renderApp(`/scans/${ID}`);
    await screen.findByText('/about');

    await user.click(screen.getByRole('button', { name: /Images\s*2/ }));
    await waitFor(() =>
      expect(api.callsTo('GET', `/scans/${ID}/pages`).at(-1)?.query.get('checkType')).toBe(
        'images',
      ),
    );
    expect(screen.getByRole('button', { name: /Images\s*2/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: /Images\s*2/ }));
    await waitFor(() =>
      expect(api.callsTo('GET', `/scans/${ID}/pages`).at(-1)?.query.get('checkType')).toBeNull(),
    );
  });

  it('starts by page, and opens a page to see its issues', async () => {
    const api = fakeApi(
      routes({
        scan: completed(),
        pages: [
          scanPage({
            id: 'pg_1',
            url: 'https://www.example.com/products/oak',
            template: '/products/:slug',
            criticalCount: 2,
            warningCount: 1,
          }),
        ],
        issues: [issue({ message: 'Image failed to load (HTTP 404).', comparison: 'new' })],
      }),
    );
    const user = userEvent.setup();
    renderApp(`/scans/${ID}`);

    expect(screen.queryByText('Image failed to load (HTTP 404).')).not.toBeInTheDocument();
    const pageButton = await screen.findByRole('button', { name: /\/products\/oak/ });
    expect(within(pageButton).getByText('/products/:slug')).toBeInTheDocument();
    expect(within(pageButton).getByText('2 critical')).toBeInTheDocument();
    expect(within(pageButton).getByText('1 warning')).toBeInTheDocument();
    expect(api.callsTo('GET', `/scans/${ID}/pages`)[0]?.query.get('hasIssues')).toBe('true');

    await user.click(pageButton);
    expect(await screen.findByText('Image failed to load (HTTP 404).')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    const request = api
      .callsTo('GET', `/scans/${ID}/issues`)
      .find((call) => call.query.get('pageId') === 'pg_1');
    expect(request?.query.get('state')).toBe('open');
  });

  it('switches to the by-issue view, grouped across pages', async () => {
    const api = fakeApi(
      routes({
        scan: completed(),
        groups: [
          group({
            affectedPages: 5,
            comparison: 'still_open',
            sample: issue({ fingerprint: 'fp-logo', message: 'Image failed to load (HTTP 404).' }),
          }),
          group({
            affectedPages: 1,
            sample: issue({ fingerprint: 'fp-2', severity: 'warning', message: 'Missing alt.' }),
          }),
        ],
        issues: [issue({ fingerprint: 'fp-logo', pageUrl: 'https://www.example.com/about' })],
      }),
    );
    const user = userEvent.setup();
    renderApp(`/scans/${ID}`);
    await user.click(await screen.findByRole('radio', { name: 'By issue' }));

    const row = await screen.findByRole('button', { name: /Image failed to load/ });
    expect(within(row).getByText('affects 5 pages')).toBeInTheDocument();
    expect(within(row).getByText('Still open')).toBeInTheDocument();
    expect(screen.getByText('affects 1 page')).toBeInTheDocument();

    await user.click(row);
    await screen.findByText('/about');
    const request = api
      .callsTo('GET', `/scans/${ID}/issues`)
      .find((call) => call.query.get('fingerprint') === 'fp-logo');
    expect(request).toBeDefined();
  });

  it('filters by severity and can include ignored issues', async () => {
    const api = fakeApi(routes({ scan: completed(), pages: [scanPage()] }));
    const user = userEvent.setup();
    renderApp(`/scans/${ID}`);
    await screen.findByText('/about');

    await user.selectOptions(screen.getByLabelText('Filter by severity'), 'warning');
    await waitFor(() =>
      expect(api.callsTo('GET', `/scans/${ID}/pages`).at(-1)?.query.get('severity')).toBe(
        'warning',
      ),
    );

    await user.click(screen.getByRole('checkbox', { name: 'Show ignored' }));
    await user.click(screen.getByRole('button', { name: /\/about/ }));
    await waitFor(() => {
      const last = api
        .callsTo('GET', `/scans/${ID}/issues`)
        .find((call) => call.query.get('pageId'));
      expect(last?.query.get('state')).toBeNull();
    });
  });

  it('says so when nothing was found', async () => {
    fakeApi(routes({ scan: completed(), pages: [] }));
    renderApp(`/scans/${ID}`);
    expect(await screen.findByText('No issues found')).toBeInTheDocument();
    expect(screen.getByText(/Every check passed: Images, Links, Page health/)).toBeInTheDocument();
  });

  it('explains a failed scan and keeps the partial results', async () => {
    fakeApi(
      routes({
        scan: detail({
          id: ID,
          status: 'failed',
          errorMessage: 'The scan stopped responding (no heartbeat for 2 minutes).',
          progress: progress({ phase: 'failed', percent: 41 }),
          summary: { healthScore: null, pages: 88, critical: 3, warnings: 5, passed: 0 },
        }),
      }),
    );
    renderApp(`/scans/${ID}`);
    expect(await screen.findByText('This scan failed')).toBeInTheDocument();
    expect(screen.getByText(/stopped responding/)).toBeInTheDocument();
    expect(screen.getByText('Critical', { selector: 'p' }).nextElementSibling).toHaveTextContent(
      '3',
    );
  });

  it('warns that a cancelled scan is incomplete', async () => {
    fakeApi(
      routes({
        scan: detail({
          id: ID,
          status: 'cancelled',
          progress: progress({ phase: 'cancelled', percent: 12 }),
        }),
      }),
    );
    renderApp(`/scans/${ID}`);
    expect(await screen.findByText('This scan was cancelled')).toBeInTheDocument();
    expect(screen.getByText(/Results are incomplete/)).toBeInTheDocument();
  });
});

describe('issue evidence', () => {
  const evidenceIssue = () =>
    issue({
      id: 'iss_evidence',
      message: 'JavaScript console error: Widget failed to initialise',
      severity: 'warning',
      checkType: 'page-health',
      selector: '#hero > img:nth-of-type(2)',
      resourceUrl: 'https://www.example.com/app.js',
      evidence: {
        rule: 'page-health.console-error',
        httpStatus: 500,
        text: 'TypeError: widget is not a function\n    at app.js:10',
        location: 'app.js:10',
      },
      screenshotUrl: 'http://qa.test/api/v1/scans/scn_000000000001/issues/iss_evidence/screenshot',
    });

  async function openEvidence() {
    const user = userEvent.setup();
    let current = evidenceIssue();
    const api = fakeApi({
      ...routes({ scan: completed(), pages: [scanPage({ id: 'pg_1' })] }),
      'GET /scans/:id/issues': () => pageOf([current]),
      'PATCH /scans/:id/issues/:issueId': (request: FakeRequest) => {
        const body = request.body as { state: 'open' | 'ignored'; ignoreNote: string | null };
        current = { ...current, state: body.state, ignoreNote: body.ignoreNote };
        return current;
      },
    });
    renderApp(`/scans/${ID}`);
    await user.click(await screen.findByRole('button', { name: /\/about/ }));
    await user.click(await screen.findByRole('button', { name: /JavaScript console error/ }));
    return { user, api };
  }

  it('shows the selector, resource, status, excerpt and rule', async () => {
    await openEvidence();
    expect(screen.getByText('#hero > img:nth-of-type(2)')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /https:\/\/www\.example\.com\/app\.js/ }),
    ).toHaveAttribute('target', '_blank');
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText(/TypeError: widget is not a function/)).toBeInTheDocument();
    expect(screen.getByText('page-health.console-error')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /https:\/\/www\.example\.com\/about/ }),
    ).toBeInTheDocument();
  });

  it('opens the screenshot in a lightbox using a path that works on any host', async () => {
    const { user } = await openEvidence();
    const thumbnail = screen.getByRole('img', { name: 'Screenshot of the problem' });
    expect(thumbnail).toHaveAttribute(
      'src',
      '/api/v1/scans/scn_000000000001/issues/iss_evidence/screenshot',
    );
    await user.click(screen.getByRole('button', { name: 'Enlarge screenshot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Screenshot' });
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', thumbnail.getAttribute('src'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('ignores an issue with a note, shows it immediately, and offers undo', async () => {
    const { user, api } = await openEvidence();
    await user.click(screen.getByRole('button', { name: 'Ignore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ignore this issue' });
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Known: tracked in MON-1042');
    await user.click(within(dialog).getByRole('button', { name: 'Ignore issue' }));

    await waitFor(() =>
      expect(api.callsTo('PATCH', `/scans/${ID}/issues/iss_evidence`)).toHaveLength(1),
    );
    expect(api.callsTo('PATCH', `/scans/${ID}/issues/iss_evidence`)[0]?.body).toEqual({
      state: 'ignored',
      ignoreNote: 'Known: tracked in MON-1042',
    });
    expect(await screen.findByText('Ignored', { selector: 'span' })).toBeInTheDocument();
    expect(await screen.findByText('Issue ignored')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(api.callsTo('PATCH', `/scans/${ID}/issues/iss_evidence`).at(-1)?.body).toMatchObject({
        state: 'open',
      }),
    );
  });

  it('updates the list before the server answers, and rolls back if it refuses', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api = fakeApi({
      ...routes({
        scan: completed(),
        pages: [scanPage({ id: 'pg_1' })],
        issues: [evidenceIssue()],
      }),
      'PATCH /scans/:id/issues/:issueId': async () => {
        await gate;
        return apiError(500, 'internal_error', 'boom');
      },
    });
    renderApp(`/scans/${ID}`);
    await user.click(await screen.findByRole('button', { name: /\/about/ }));
    await user.click(await screen.findByRole('button', { name: /JavaScript console error/ }));
    await user.click(screen.getByRole('button', { name: 'Ignore' }));
    await user.click(await screen.findByRole('button', { name: 'Ignore issue' }));

    // The request is still pending, yet the issue already shows as ignored.
    expect(await screen.findByText('Ignored', { selector: 'span' })).toBeInTheDocument();
    expect(api.callsTo('PATCH', `/scans/${ID}/issues/iss_evidence`)).toHaveLength(1);

    release();
    expect(await screen.findByText('Could not update the issue. Try again.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Ignored', { selector: 'span' })).not.toBeInTheDocument(),
    );
  });

  it('reopens an ignored issue', async () => {
    const user = userEvent.setup();
    const ignored = { ...evidenceIssue(), state: 'ignored' as const, ignoreNote: 'Known' };
    const api = fakeApi({
      ...routes({ scan: completed(), pages: [scanPage({ id: 'pg_1' })], issues: [ignored] }),
      'PATCH /scans/:id/issues/:issueId': () => ({ ...ignored, state: 'open', ignoreNote: null }),
    });
    renderApp(`/scans/${ID}`);
    await user.click(await screen.findByRole('button', { name: /\/about/ }));
    await user.click(await screen.findByRole('button', { name: /JavaScript console error/ }));
    expect(screen.getByText('Known')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() =>
      expect(api.callsTo('PATCH', `/scans/${ID}/issues/iss_evidence`)[0]?.body).toEqual({
        state: 'open',
        ignoreNote: null,
      }),
    );
  });
});

describe('scan actions and errors', () => {
  it('re-scans with the same address, checks and form mode', async () => {
    const api = fakeApi({
      ...routes({
        scan: detail({
          id: ID,
          url: 'https://www.example.com/',
          formMode: 'validate_only',
          checks: ['images', 'seo'],
        }),
      }),
      'POST /scans': () => ({
        status: 202,
        body: { id: 'scn_next', status: 'queued', statusUrl: 's', reportUrl: 'r' },
      }),
    });
    const user = userEvent.setup();
    renderApp(`/scans/${ID}`);
    await user.click(await screen.findByRole('button', { name: 'Re-scan' }));
    await waitFor(() => expect(location()).toBe('/scans/scn_next'));
    expect(api.callsTo('POST', '/scans')[0]?.body).toEqual({
      url: 'https://www.example.com/',
      checks: ['images', 'seo'],
      formMode: 'validate_only',
    });
  });

  it('copies a share link', async () => {
    fakeApi(routes({ scan: completed() }));
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp(`/scans/${ID}`);
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.href));
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });

  it('shows a not-found page for an unknown scan', async () => {
    fakeApi({
      ...routes(),
      'GET /scans/:id': () => apiError(404, 'not_found', 'Scan scn_x was not found.'),
    });
    renderApp('/scans/scn_x');
    expect(await screen.findByText('Scan not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to scans' })).toHaveAttribute('href', '/scans');
  });

  it('explains other errors and retries', async () => {
    let fail = true;
    fakeApi({
      ...routes({ scan: completed() }),
      'GET /scans/:id': () =>
        fail
          ? apiError(500, 'internal_error', 'The server had a problem. Try again in a moment.')
          : completed(),
    });
    const user = userEvent.setup();
    renderApp(`/scans/${ID}`);
    expect(await screen.findByRole('alert', {}, { timeout: 8000 })).toHaveTextContent(
      'Could not load this scan',
    );
    fail = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Issues by check')).toBeInTheDocument();
  }, 20_000);

  it('shows a skeleton with the shape of the page while loading', async () => {
    fakeApi({ ...routes(), 'GET /scans/:id': () => new Promise(() => undefined) });
    renderApp(`/scans/${ID}`);
    expect(await screen.findByLabelText('Loading scan')).toHaveAttribute('aria-busy', 'true');
  });
});
