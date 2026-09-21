import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, fakeApi } from '@/test/fake-api';
import { pageOf, progress, scan, session, settings } from '@/test/builders';
import { renderApp } from '@/test/render';

const location = () => screen.getByTestId('location').textContent;

function routes(scans = [scan()]) {
  return {
    'GET /auth/me': () => session(),
    'GET /settings': () => settings(),
    'GET /scans': () => pageOf(scans),
  };
}

const rowFor = (host: string) =>
  screen.getByRole('link', { name: host }).closest('tr') as HTMLElement;

describe('dashboard scan list', () => {
  it('shows every scan with its status, progress, score, counts and trigger', async () => {
    fakeApi(
      routes([
        scan({
          id: 'scn_run',
          hostname: 'shop.example.com',
          status: 'running',
          summary: { healthScore: null, pages: 214, critical: 6, warnings: 14, passed: 0 },
          progress: progress({
            phase: 'running',
            percent: 41,
            pagesFound: 214,
            pagesDone: 87,
            pagesTotal: 214,
            etaSeconds: 148,
          }),
          finishedAt: null,
        }),
        scan({
          id: 'scn_queue',
          hostname: 'blog.example.com',
          status: 'queued',
          progress: progress({ queuePosition: 2 }),
          summary: { healthScore: null, pages: 0, critical: 0, warnings: 0, passed: 0 },
          startedAt: null,
          finishedAt: null,
        }),
        scan({
          id: 'scn_disc',
          hostname: 'docs.example.com',
          status: 'discovering',
          progress: progress({ phase: 'discovering', pagesFound: 143 }),
          summary: { healthScore: null, pages: 0, critical: 0, warnings: 0, passed: 0 },
          finishedAt: null,
        }),
        scan({ id: 'scn_done', hostname: 'www.example.com', runNumber: 7 }),
        scan({
          id: 'scn_fail',
          hostname: 'careers.example.com',
          status: 'failed',
          progress: progress({ phase: 'failed', percent: 41, pagesDone: 36, pagesTotal: 88 }),
          summary: { healthScore: null, pages: 88, critical: 3, warnings: 5, passed: 0 },
        }),
      ]),
    );
    renderApp('/');

    const running = within(await waitFor(() => rowFor('shop.example.com')));
    expect(running.getByText('Running')).toBeInTheDocument();
    expect(running.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '41');
    expect(running.getByText('41%')).toBeInTheDocument();
    expect(running.getByText('87 of 214 pages')).toBeInTheDocument();
    expect(running.getByText('about 2 min left')).toBeInTheDocument();
    expect(running.getByText('6')).toBeInTheDocument();
    expect(running.getByText('14')).toBeInTheDocument();

    const queued = within(rowFor('blog.example.com'));
    expect(queued.getByText('2nd in queue')).toBeInTheDocument();
    expect(queued.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

    const discovering = within(rowFor('docs.example.com'));
    expect(discovering.getByText('Discovering pages, 143 found so far')).toBeInTheDocument();
    expect(discovering.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');

    const done = within(rowFor('www.example.com'));
    expect(done.getByText('#7')).toBeInTheDocument();
    expect(done.getByText('Completed in 4 min 12 s')).toBeInTheDocument();
    expect(done.getByLabelText('Health score 82 out of 100, Fair')).toBeInTheDocument();
    expect(done.getByText('n8n production')).toBeInTheDocument();

    const failed = within(rowFor('careers.example.com'));
    // The status badge and the frozen progress both say so.
    expect(failed.getAllByText('Failed')).toHaveLength(2);
    expect(failed.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '41');
  });

  it('opens a scan from its row', async () => {
    fakeApi({
      ...routes([scan({ id: 'scn_abc' })]),
      'GET /scans/:id': () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'gone' } },
      }),
    });
    const user = userEvent.setup();
    renderApp('/');
    const row = await waitFor(() => rowFor('www.example.com'));
    await user.click(within(row).getByText('n8n production'));
    await waitFor(() => expect(location()).toBe('/scans/scn_abc'));
  });

  it('picks up progress on its own while a scan is active', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let percent = 20;
    fakeApi({
      ...routes(),
      'GET /scans': () =>
        pageOf([
          scan({
            status: 'running',
            progress: progress({
              phase: 'running',
              percent,
              pagesDone: percent,
              pagesTotal: 100,
              etaSeconds: 60,
            }),
          }),
        ]),
    });
    renderApp('/');
    expect(await screen.findByText('20%')).toBeInTheDocument();
    percent = 55;
    await vi.advanceTimersByTimeAsync(2200);
    expect(await screen.findByText('55%')).toBeInTheDocument();
  });

  it('shows a skeleton while loading', () => {
    fakeApi({ ...routes(), 'GET /scans': () => new Promise(() => undefined) });
    renderApp('/');
    return screen.findByLabelText('Loading scans').then((skeleton) => {
      expect(skeleton).toHaveAttribute('aria-busy', 'true');
    });
  });

  it('invites the first scan when there are none', async () => {
    fakeApi(routes([]));
    const user = userEvent.setup();
    renderApp('/');
    expect(await screen.findByText('Run your first scan')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enter a site address' }));
    expect(screen.getByLabelText('Site address')).toHaveFocus();
  });

  it('explains a failure and lets you retry', async () => {
    let fail = true;
    fakeApi({
      ...routes(),
      'GET /scans': () =>
        fail
          ? apiError(500, 'internal_error', 'The server had a problem. Try again in a moment.')
          : pageOf([scan()]),
    });
    const user = userEvent.setup();
    renderApp('/');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load scans');
    expect(screen.getByRole('alert')).toHaveTextContent('The server had a problem.');
    fail = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await screen.findByRole('link', { name: 'www.example.com' });
  });

  it('filters by status, search text and site, and can clear them', async () => {
    const api = fakeApi(
      routes([scan({ hostname: 'a.example.com' }), scan({ hostname: 'b.example.com' })]),
    );
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('link', { name: 'a.example.com' });

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'running');
    await waitFor(() =>
      expect(api.callsTo('GET', '/scans').at(-1)?.query.get('status')).toBe('running'),
    );

    await user.selectOptions(screen.getByLabelText('Filter by site'), 'b.example.com');
    await waitFor(() =>
      expect(api.callsTo('GET', '/scans').at(-1)?.query.get('hostname')).toBe('b.example.com'),
    );

    await user.type(screen.getByLabelText('Search sites'), 'shop');
    await waitFor(() => expect(api.callsTo('GET', '/scans').at(-1)?.query.get('q')).toBe('shop'));

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      const last = api.callsTo('GET', '/scans').at(-1)?.query;
      expect(last?.get('status')).toBeNull();
      expect(last?.get('hostname')).toBeNull();
      expect(last?.get('q')).toBeNull();
    });
  });

  it('says so when filters match nothing', async () => {
    fakeApi({
      ...routes(),
      'GET /scans': (request) => pageOf(request.query.get('status') ? [] : [scan()]),
    });
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('link', { name: 'www.example.com' });
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'failed');
    expect(await screen.findByText('No scans match these filters')).toBeInTheDocument();
  });

  it('loads more scans with the cursor', async () => {
    const api = fakeApi({
      ...routes(),
      'GET /scans': (request) =>
        request.query.get('cursor') === 'next'
          ? pageOf([scan({ hostname: 'older.example.com' })])
          : pageOf([scan({ hostname: 'newer.example.com' })], 'next'),
    });
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('link', { name: 'newer.example.com' });
    await user.click(screen.getByRole('button', { name: 'Load more scans' }));
    await screen.findByRole('link', { name: 'older.example.com' });
    expect(screen.getByRole('link', { name: 'newer.example.com' })).toBeInTheDocument();
    expect(api.callsTo('GET', '/scans').some((call) => call.query.get('cursor') === 'next')).toBe(
      true,
    );
  });
});

describe('starting a scan', () => {
  it('checks the address before sending anything', async () => {
    const api = fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/');
    await user.type(await screen.findByLabelText('Site address'), 'not a url');
    await user.click(screen.getByRole('button', { name: /new scan/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a full site address');
    expect(api.callsTo('POST', '/scans')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Site address'));
    await user.type(screen.getByLabelText('Site address'), 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('starts a scan with the default checks and opens it', async () => {
    const api = fakeApi({
      ...routes(),
      'POST /scans': () => ({
        status: 202,
        body: { id: 'scn_new', status: 'queued', statusUrl: 's', reportUrl: 'r' },
      }),
      'GET /scans/:id': () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'x' } },
      }),
    });
    const user = userEvent.setup();
    renderApp('/');
    await user.type(await screen.findByLabelText('Site address'), 'www.example.com');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scan options' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /new scan/i }));

    await waitFor(() => expect(location()).toBe('/scans/scn_new'));
    const request = api.callsTo('POST', '/scans')[0];
    expect(request?.body).toEqual({
      url: 'https://www.example.com/',
      checks: ['images', 'links', 'staging-urls', 'page-health'],
      formMode: 'detect',
    });
    expect(request?.headers['idempotency-key']).toBeTruthy();
  });

  it('lets you change the checks and form mode in the options popover', async () => {
    const api = fakeApi({
      ...routes(),
      'POST /scans': () => ({
        status: 202,
        body: { id: 'scn_new', status: 'queued', statusUrl: 's', reportUrl: 'r' },
      }),
      'GET /scans/:id': () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'x' } },
      }),
    });
    const user = userEvent.setup();
    renderApp('/');
    await user.type(await screen.findByLabelText('Site address'), 'https://www.example.com');
    await user.click(screen.getByRole('button', { name: 'Scan options' }));

    await user.click(screen.getByRole('checkbox', { name: 'Links' }));
    await user.click(screen.getByRole('radio', { name: /validate only/i }));
    // Every check can be chosen, and the form modes say what they will and will not do.
    expect(screen.getByRole('checkbox', { name: 'Forms' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Forms' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'SEO' }));
    expect(
      screen.getByText(/Login, payment, CAPTCHA and third-party forms are never touched/),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing reaches the server/i)).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /new scan/i }));
    await waitFor(() => expect(api.callsTo('POST', '/scans')).toHaveLength(1));
    expect(api.callsTo('POST', '/scans')[0]?.body).toMatchObject({
      checks: ['images', 'staging-urls', 'page-health', 'seo'],
      formMode: 'validate_only',
    });
  });

  it('refuses to start with no checks selected', async () => {
    const api = fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/');
    await user.type(await screen.findByLabelText('Site address'), 'https://www.example.com');
    await user.click(screen.getByRole('button', { name: 'Scan options' }));
    for (const name of ['Images', 'Links', 'Staging URLs', 'Page health']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /new scan/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one check');
    expect(api.callsTo('POST', '/scans')).toHaveLength(0);
  });

  it('shows the API message when the site is not allowed', async () => {
    fakeApi({
      ...routes(),
      'POST /scans': () =>
        apiError(
          422,
          'domain_not_allowed',
          'evil.test is not on the allowed domains list. Ask an admin to add it in Settings, then try again.',
        ),
    });
    const user = userEvent.setup();
    renderApp('/');
    await user.type(await screen.findByLabelText('Site address'), 'https://evil.test');
    await user.click(screen.getByRole('button', { name: /new scan/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ask an admin to add it in Settings',
    );
  });

  it('points to the running scan when the site already has one', async () => {
    fakeApi({
      ...routes(),
      'POST /scans': () =>
        apiError(
          409,
          'conflict',
          'A scan of www.example.com is already running. Wait for it to finish or cancel it first.',
          {
            scan: { id: 'scn_existing' },
          },
        ),
    });
    const user = userEvent.setup();
    renderApp('/');
    await user.type(await screen.findByLabelText('Site address'), 'https://www.example.com');
    await user.click(screen.getByRole('button', { name: /new scan/i }));
    const link = await screen.findByRole('link', { name: 'View that scan' });
    expect(link).toHaveAttribute('href', '/scans/scn_existing');
  });
});
