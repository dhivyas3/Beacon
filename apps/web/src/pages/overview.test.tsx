import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { detail, pageOf, progress, session, website } from '@/test/builders';
import { apiError, fakeApi } from '@/test/fake-api';
import { renderApp } from '@/test/render';

function routes(websites = [website()]) {
  return {
    'GET /auth/me': () => session(),
    'GET /websites': () => pageOf(websites),
  };
}

const cardFor = (name: string) =>
  screen.getByRole('link', { name }).closest('div.relative') as HTMLElement;

describe('overview', () => {
  it('shows a card per website with score, change, counts and the next check', async () => {
    fakeApi(
      routes([
        website({
          id: 'web_a',
          name: 'Example Estates',
          latest: {
            scanId: 'scn_1',
            runNumber: 7,
            status: 'completed',
            healthScore: 94,
            critical: 0,
            warnings: 3,
            pages: 8,
            finishedAt: '2026-09-01T06:04:12.000Z',
            scoreChange: 4,
            triggeredByType: 'scheduled',
          },
        }),
      ]),
    );
    renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    const card = within(await waitForCard('Example Estates'));
    expect(card.getByText('94')).toBeInTheDocument();
    expect(card.getByText('Good')).toBeInTheDocument();
    expect(card.getByText(/\+4/)).toBeInTheDocument();
    expect(card.getByText('Warnings').nextSibling).toHaveTextContent('3');
    expect(card.getByText(/Next check/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Example Estates' })).toHaveAttribute(
      'href',
      '/websites/web_a',
    );
  });

  it('puts what needs attention first and paused websites last', async () => {
    const healthy = website({ name: 'Healthy site' });
    const poor = website({
      name: 'Broken site',
      latest: {
        scanId: 'scn_2',
        runNumber: 3,
        status: 'completed',
        healthScore: 41,
        critical: 6,
        warnings: 9,
        pages: 8,
        finishedAt: '2026-09-01T06:04:12.000Z',
        scoreChange: -12,
        triggeredByType: 'scheduled',
      },
    });
    const paused = website({ name: 'Paused site', isActive: false, nextCheckAt: null });
    fakeApi(routes([paused, healthy, poor]));
    renderApp('/');

    await waitForCard('Paused site');
    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(['Broken site', 'Healthy site', 'Paused site']);

    const summary = within(screen.getByRole('region', { name: 'Summary' }));
    expect(summary.getByText('Need attention').nextSibling).toHaveTextContent('1');
    expect(
      within(cardFor('Paused site')).getByText('Paused', { selector: 'span' }),
    ).toBeInTheDocument();
    expect(within(cardFor('Broken site')).getByText(/−12/)).toBeInTheDocument();
  });

  it('shows the live progress of a check that is running', async () => {
    fakeApi({
      ...routes([website({ name: 'Live site', activeScanId: 'scn_live' })]),
      'GET /scans/:id': () =>
        detail({
          id: 'scn_live',
          runNumber: 8,
          status: 'running',
          progress: progress({ phase: 'running', percent: 42, pagesDone: 3, pagesTotal: 8 }),
          finishedAt: null,
        }),
    });
    renderApp('/');

    const card = within(await waitForCard('Live site'));
    expect(await card.findByText('Checking now')).toBeInTheDocument();
    expect(await card.findByRole('progressbar')).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'Follow this check' })).toHaveAttribute(
      'href',
      '/scans/scn_live',
    );
  });

  it('says so when a website has never been checked', async () => {
    fakeApi(routes([website({ name: 'Fresh site', latest: null, lastCheckAt: null })]));
    renderApp('/');
    const card = within(await waitForCard('Fresh site'));
    expect(card.getByText(/No completed check yet/)).toBeInTheDocument();
    expect(card.getByText('Never checked')).toBeInTheDocument();
  });

  it('warns on the card when the last email failed or a scheduled check could not start', async () => {
    fakeApi(
      routes([
        website({
          name: 'Trouble site',
          lastRunError: 'The domain is not allowed any more.',
          emailStatus: {
            scanId: 'scn_1',
            sent: 0,
            failed: 1,
            pending: 0,
            lastError: 'Mailbox full',
          },
        }),
      ]),
    );
    renderApp('/');
    const card = within(await waitForCard('Trouble site'));
    expect(card.getByText('Last scheduled check could not start')).toBeInTheDocument();
    expect(card.getByText('The last report email failed')).toBeInTheDocument();
  });

  it('says a check failed rather than that none has run', async () => {
    fakeApi(
      routes([
        website({
          name: 'Down site',
          latest: {
            scanId: 'scn_failed',
            runNumber: 2,
            status: 'failed',
            healthScore: null,
            critical: 0,
            warnings: 0,
            pages: 0,
            finishedAt: '2026-09-01T06:04:12.000Z',
            scoreChange: null,
            triggeredByType: 'scheduled',
          },
        }),
      ]),
    );
    renderApp('/');
    const card = within(await waitForCard('Down site'));
    expect(card.getByText(/The last check could not finish/)).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'See why' })).toHaveAttribute(
      'href',
      '/scans/scn_failed',
    );
    expect(card.getByText(/Last attempt/)).toBeInTheDocument();
    expect(card.queryByText(/No completed check yet/)).not.toBeInTheDocument();
  });

  it('invites you to add a first website', async () => {
    fakeApi(routes([]));
    renderApp('/');
    expect(await screen.findByText('Add your first website')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Add website' })[0]).toHaveAttribute(
      'href',
      '/websites/new',
    );
    expect(screen.getByRole('link', { name: 'Run a one-off scan' })).toHaveAttribute(
      'href',
      '/scans',
    );
  });

  it('explains a failure and retries', async () => {
    let fail = true;
    fakeApi({
      'GET /auth/me': () => session(),
      'GET /websites': () =>
        fail ? apiError(500, 'internal_error', 'The server had a problem.') : pageOf([website()]),
    });
    renderApp('/');
    expect(await screen.findByText('Could not load websites')).toBeInTheDocument();
    fail = false;
    (await screen.findByRole('button', { name: 'Try again' })).click();
    expect(await screen.findByRole('link', { name: 'Example Estates' })).toBeInTheDocument();
  });
});

async function waitForCard(name: string): Promise<HTMLElement> {
  const link = await screen.findByRole('link', { name });
  return link.closest('div.relative') as HTMLElement;
}
