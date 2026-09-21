import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  detail,
  emailDelivery,
  historyItem,
  pageOf,
  progress,
  recipient,
  session,
  website,
} from '@/test/builders';
import { apiError, fakeApi } from '@/test/fake-api';
import { renderApp } from '@/test/render';

const location = () => screen.getByTestId('location').textContent;

type Routes = Record<string, (request: never) => unknown>;

function routes(extra: Routes = {}) {
  return {
    'GET /auth/me': () => session(),
    'GET /websites': () => pageOf([]),
    'GET /websites/:id': () => website({ id: 'web_a' }),
    'GET /websites/:id/history': () =>
      pageOf([
        historyItem({ scanId: 'scn_h2', runNumber: 2, healthScore: 94, warnings: 3 }),
        historyItem({ scanId: 'scn_h1', runNumber: 1, healthScore: 82, critical: 2, warnings: 9 }),
      ]),
    'GET /websites/:id/email-deliveries': () => pageOf([emailDelivery()]),
    ...extra,
  };
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'Example Estates' });

describe('website detail', () => {
  it('shows the website, its latest check and the history of scores', async () => {
    fakeApi(routes());
    renderApp('/websites/web_a');

    await heading();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /www\.example-estates\.co\.uk/ })).toHaveAttribute(
      'href',
      'https://www.example-estates.co.uk/',
    );
    expect(screen.getAllByText(/Monthly on the 1st at 06:00 UTC/).length).toBeGreaterThan(0);
    expect(screen.getByText('Different pages, across every check')).toBeInTheDocument();
    expect(screen.getByText('41')).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: 'Completed checks, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: '#2 report' })).toHaveAttribute(
      'href',
      '/scans/scn_h2',
    );
    expect(within(rows[1] as HTMLElement).getByText('82')).toBeInTheDocument();
    expect(screen.getByText('Health score over time')).toBeInTheDocument();
  });

  it('describes how the website is configured', async () => {
    fakeApi(
      routes({
        'GET /websites/:id': () =>
          website({
            id: 'web_a',
            pinnedPageUrls: ['https://www.example-estates.co.uk/contact'],
            enabledChecks: ['images', 'seo'],
          }),
      }),
    );
    renderApp('/websites/web_a');
    await heading();
    expect(
      screen.getByText('8 random pages, homepage always included, plus 1 pinned'),
    ).toBeInTheDocument();
    expect(screen.getByText('https://www.example-estates.co.uk/contact')).toBeInTheDocument();
    expect(screen.getByText('Images, SEO')).toBeInTheDocument();
    expect(screen.getByText('Validate only')).toBeInTheDocument();
  });

  it('starts a check and follows it', async () => {
    const api = fakeApi(
      routes({
        'POST /websites/:id/check-now': () => ({
          status: 202,
          body: {
            id: 'scn_new',
            status: 'queued',
            statusUrl: 'http://qa.test/api/v1/scans/scn_new',
            reportUrl: 'http://qa.test/scans/scn_new',
          },
        }),
        'GET /scans/:id': () => detail({ id: 'scn_new', status: 'queued' }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/web_a');
    await heading();
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(location()).toBe('/scans/scn_new'));
    expect(api.callsTo('POST', '/websites/web_a/check-now')).toHaveLength(1);
  });

  it('shows a running check with its progress and does not offer another', async () => {
    fakeApi(
      routes({
        'GET /websites/:id': () => website({ id: 'web_a', activeScanId: 'scn_live' }),
        'GET /scans/:id': () =>
          detail({
            id: 'scn_live',
            runNumber: 8,
            status: 'running',
            progress: progress({ phase: 'running', percent: 60, pagesDone: 5, pagesTotal: 8 }),
            finishedAt: null,
          }),
      }),
    );
    renderApp('/websites/web_a');
    await heading();
    expect(await screen.findByText('Check in progress')).toBeInTheDocument();
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  });

  it('explains why a check could not start', async () => {
    fakeApi(
      routes({
        'POST /websites/:id/check-now': () =>
          apiError(409, 'conflict', 'This website already has a check running.'),
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/web_a');
    await heading();
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(
      await screen.findByText('This website already has a check running.'),
    ).toBeInTheDocument();
    expect(location()).toBe('/websites/web_a');
  });

  it('pauses and resumes', async () => {
    let current = website({ id: 'web_a' });
    const api = fakeApi(
      routes({
        'GET /websites/:id': () => current,
        'PATCH /websites/:id': (request: { body: unknown }) => {
          current = { ...current, ...(request.body as object) };
          return current;
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/web_a');
    await heading();

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Website paused')).toBeInTheDocument();
    expect(api.callsTo('PATCH', '/websites/web_a')[0]?.body).toEqual({ isActive: false });
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByText('Paused', { selector: 'span' })).toBeInTheDocument();
  });

  it('asks before deleting, then returns to the list', async () => {
    const api = fakeApi(routes({ 'DELETE /websites/:id': () => ({ status: 204 }) }));
    const user = userEvent.setup();
    renderApp('/websites/web_a');
    await heading();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Example Estates?' });
    expect(api.callsTo('DELETE', '/websites/web_a')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete website' }));

    await waitFor(() => expect(location()).toBe('/websites'));
    expect(api.callsTo('DELETE', '/websites/web_a')).toHaveLength(1);
  });

  it('warns when the schedule could not start or an email failed', async () => {
    fakeApi(
      routes({
        'GET /websites/:id': () =>
          website({
            id: 'web_a',
            lastRunError: 'www.example-estates.co.uk is no longer on the allowed domains list.',
            emailStatus: {
              scanId: 'scn_1',
              sent: 1,
              failed: 1,
              pending: 0,
              lastError: 'Mailbox full',
            },
          }),
      }),
    );
    renderApp('/websites/web_a');
    await heading();
    expect(screen.getByText('The last scheduled check could not start')).toBeInTheDocument();
    expect(screen.getByText(/no longer on the allowed domains list/)).toBeInTheDocument();
    expect(screen.getByText('A report email did not go out')).toBeInTheDocument();
    expect(screen.getByText(/Mailbox full/)).toBeInTheDocument();
  });

  it('says so when there is no history yet, and when history fails', async () => {
    fakeApi(routes({ 'GET /websites/:id/history': () => pageOf([]) }));
    renderApp('/websites/web_a');
    await heading();
    expect(await screen.findByText('No completed checks yet')).toBeInTheDocument();
  });

  it('shows an error for the history and lets you retry', async () => {
    fakeApi(
      routes({
        'GET /websites/:id/history': () =>
          apiError(500, 'internal_error', 'The server had a problem.'),
      }),
    );
    renderApp('/websites/web_a');
    await heading();
    expect(await screen.findByText('Could not load the history')).toBeInTheDocument();
  });

  it('shows not found for a website that does not exist', async () => {
    fakeApi(
      routes({
        'GET /websites/:id': () => apiError(404, 'not_found', 'Website web_x was not found.'),
      }),
    );
    renderApp('/websites/web_x');
    expect(await screen.findByText('Website not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to websites' })).toHaveAttribute(
      'href',
      '/websites',
    );
  });
});

describe('recipients', () => {
  const owner = recipient({
    id: 'rcp_owner',
    email: 'owner@example-estates.co.uk',
    name: 'Sam Owner',
  });
  const editor = recipient({
    id: 'rcp_editor',
    email: 'editor@example-estates.co.uk',
    name: null,
    isActive: false,
    notify: 'new_issues_only',
  });
  const withRecipients = () => ({
    'GET /websites/:id': () => website({ id: 'web_a', recipients: [owner, editor] }),
  });

  it('lists who receives what, and marks paused recipients', async () => {
    fakeApi(routes(withRecipients()));
    renderApp('/websites/web_a');
    await heading();
    expect(screen.getByText('owner@example-estates.co.uk')).toBeInTheDocument();
    expect(screen.getByText('Sam Owner')).toBeInTheDocument();
    expect(screen.getByLabelText('What editor@example-estates.co.uk receives')).toHaveValue(
      'new_issues_only',
    );
    const rows = screen.getAllByRole('checkbox', { name: 'Receives emails' });
    expect(rows[0]).toBeChecked();
    expect(rows[1]).not.toBeChecked();
  });

  it('changes what a recipient receives and pauses them, straight away', async () => {
    const api = fakeApi(
      routes({
        ...withRecipients(),
        'PATCH /websites/:id/recipients/:recipientId': () => owner,
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/web_a');
    await heading();

    await user.selectOptions(
      screen.getByLabelText('What owner@example-estates.co.uk receives'),
      'new_issues_only',
    );
    await user.click(
      screen.getAllByRole('checkbox', { name: 'Receives emails' })[0] as HTMLElement,
    );

    await waitFor(() =>
      expect(api.callsTo('PATCH', '/websites/web_a/recipients/rcp_owner')).toHaveLength(2),
    );
    const bodies = api
      .callsTo('PATCH', '/websites/web_a/recipients/rcp_owner')
      .map((call) => call.body);
    expect(bodies).toEqual([{ notify: 'new_issues_only' }, { isActive: false }]);
  });

  it('removes a recipient', async () => {
    const api = fakeApi(
      routes({
        ...withRecipients(),
        'DELETE /websites/:id/recipients/:recipientId': () => ({ status: 204 }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/web_a');
    await heading();
    await user.click(screen.getByRole('button', { name: 'Remove editor@example-estates.co.uk' }));
    expect(await screen.findByText('editor@example-estates.co.uk removed')).toBeInTheDocument();
    expect(api.callsTo('DELETE', '/websites/web_a/recipients/rcp_editor')).toHaveLength(1);
  });

  it('adds a recipient, and refuses a bad address before asking the server', async () => {
    const api = fakeApi(
      routes({
        ...withRecipients(),
        'POST /websites/:id/recipients': (request: { body: unknown }) => ({
          status: 201,
          body: recipient({ id: 'rcp_new', ...(request.body as object) }),
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/web_a');
    await heading();

    const form = within(screen.getByRole('form', { name: 'Add a recipient' }));
    await user.type(form.getByLabelText('Email address'), 'nope');
    await user.click(form.getByRole('button', { name: 'Add recipient' }));
    expect(await form.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(api.callsTo('POST', '/websites/web_a/recipients')).toHaveLength(0);

    await user.clear(form.getByLabelText('Email address'));
    await user.type(form.getByLabelText('Email address'), 'kim@example-estates.co.uk');
    await user.type(form.getByLabelText('Name (optional)'), 'Kim');
    await user.click(form.getByRole('button', { name: 'Add recipient' }));
    expect(await screen.findByText('kim@example-estates.co.uk added')).toBeInTheDocument();
    expect(api.callsTo('POST', '/websites/web_a/recipients')[0]?.body).toEqual({
      email: 'kim@example-estates.co.uk',
      name: 'Kim',
    });
  });

  it('shows the server reason when a recipient cannot be added', async () => {
    fakeApi(
      routes({
        ...withRecipients(),
        'POST /websites/:id/recipients': () =>
          apiError(409, 'conflict', 'owner@example-estates.co.uk already receives this report.'),
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/web_a');
    await heading();
    const form = within(screen.getByRole('form', { name: 'Add a recipient' }));
    await user.type(form.getByLabelText('Email address'), 'owner@example-estates.co.uk');
    await user.click(form.getByRole('button', { name: 'Add recipient' }));
    expect(await form.findByText(/already receives this report/)).toBeInTheDocument();
  });

  it('offers to turn emails back on when they are off', async () => {
    const api = fakeApi(
      routes({
        'GET /websites/:id': () => website({ id: 'web_a', emailEnabled: false }),
        'PATCH /websites/:id': () => website({ id: 'web_a', emailEnabled: true }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/web_a');
    await heading();
    expect(screen.getByText('Emails are turned off for this website')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(api.callsTo('PATCH', '/websites/web_a')).toHaveLength(1));
    expect(api.callsTo('PATCH', '/websites/web_a')[0]?.body).toEqual({ emailEnabled: true });
  });

  it('says when nobody is emailed yet', async () => {
    fakeApi(routes({ 'GET /websites/:id': () => website({ id: 'web_a', recipients: [] }) }));
    renderApp('/websites/web_a');
    await heading();
    expect(screen.getByText(/No recipients yet/)).toBeInTheDocument();
  });
});

describe('email deliveries', () => {
  it('shows what was sent and why something was not', async () => {
    fakeApi(
      routes({
        'GET /websites/:id/email-deliveries': () =>
          pageOf([
            emailDelivery({ id: 'eml_1', status: 'sent' }),
            emailDelivery({
              id: 'eml_2',
              email: 'bounce@example-estates.co.uk',
              status: 'failed',
              attempts: 6,
              error: 'Mailbox does not exist',
              sentAt: null,
            }),
            emailDelivery({
              id: 'eml_3',
              email: 'quiet@example-estates.co.uk',
              status: 'skipped',
              error: 'Only wants reports with new issues',
              sentAt: null,
            }),
          ]),
      }),
    );
    renderApp('/websites/web_a');
    await heading();
    const table = await screen.findByRole('table', { name: 'Report emails, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).getByText('Sent')).toBeInTheDocument();
    const failed = within(rows[1] as HTMLElement);
    expect(failed.getByText('Failed')).toBeInTheDocument();
    expect(failed.getByText('Mailbox does not exist')).toBeInTheDocument();
    expect(failed.getByText('6 attempts')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Not sent')).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: 'View report' }),
    ).toHaveAttribute('href', '/scans/scn_000000000100');
  });

  it('has an empty state and an error state', async () => {
    fakeApi(routes({ 'GET /websites/:id/email-deliveries': () => pageOf([]) }));
    renderApp('/websites/web_a');
    await heading();
    expect(await screen.findByText(/No emails yet/)).toBeInTheDocument();
  });

  it('explains when the emails cannot be loaded', async () => {
    fakeApi(
      routes({
        'GET /websites/:id/email-deliveries': () =>
          apiError(500, 'internal_error', 'The server had a problem.'),
      }),
    );
    renderApp('/websites/web_a');
    await heading();
    expect(await screen.findByText('Could not load emails')).toBeInTheDocument();
  });
});
