import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { pageOf, session, website } from '@/test/builders';
import { apiError, fakeApi } from '@/test/fake-api';
import { renderApp } from '@/test/render';

const location = () => screen.getByTestId('location').textContent;

function routes(extra: Record<string, (request: never) => unknown> = {}) {
  return {
    'GET /auth/me': () => session(),
    'GET /websites': () => pageOf([]),
    'GET /websites/:id': () => website({ id: 'web_new', name: 'Example Estates' }),
    'GET /websites/:id/history': () => pageOf([]),
    'GET /websites/:id/email-deliveries': () => pageOf([]),
    ...extra,
  };
}

describe('adding a website', () => {
  it('sends the schedule, page selection, checks and recipients that were chosen', async () => {
    let created: Record<string, unknown> | null = null;
    const api = fakeApi(
      routes({
        'POST /websites': (request: { body: unknown }) => {
          created = request.body as Record<string, unknown>;
          return { status: 201, body: website({ id: 'web_new', name: 'Example Estates' }) };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/new');

    await user.type(await screen.findByLabelText('Name'), 'Example Estates');
    await user.type(screen.getByLabelText('Address'), 'https://www.example-estates.co.uk');
    await user.selectOptions(screen.getByLabelText('How often'), 'monthly');
    await user.selectOptions(screen.getByLabelText('On day'), '15');
    await user.selectOptions(screen.getByLabelText('At (UTC)'), '7');
    await user.clear(screen.getByLabelText('Number of pages'));
    await user.type(screen.getByLabelText('Number of pages'), '8');
    await user.type(
      screen.getByLabelText('Pages to always include (optional)'),
      '/contact{Enter}https://www.example-estates.co.uk/pricing',
    );
    await user.type(screen.getByLabelText('Recipient email 1'), 'sam@example-estates.co.uk');
    await user.click(screen.getByRole('button', { name: 'Add recipient' }));
    await user.type(screen.getByLabelText('Recipient email 2'), 'kim@example-estates.co.uk');
    await user.selectOptions(screen.getByLabelText('What recipient 2 receives'), 'new_issues_only');
    await user.click(screen.getByRole('button', { name: 'Add website' }));

    await waitFor(() => expect(location()).toBe('/websites/web_new'));
    expect(api.callsTo('POST', '/websites')).toHaveLength(1);
    expect(created).toMatchObject({
      name: 'Example Estates',
      url: 'https://www.example-estates.co.uk/',
      checkFrequency: 'monthly',
      scheduleDayOfMonth: 15,
      scheduleDayOfWeek: null,
      scheduleHourUtc: 7,
      pageSelectionMode: 'random_sample',
      sampleSize: 8,
      pinnedPageUrls: [
        'https://www.example-estates.co.uk/contact',
        'https://www.example-estates.co.uk/pricing',
      ],
      staticPageUrls: [],
      formMode: 'validate_only',
      emailEnabled: true,
      recipients: [
        { email: 'sam@example-estates.co.uk', name: null, notify: 'every_check' },
        { email: 'kim@example-estates.co.uk', name: null, notify: 'new_issues_only' },
      ],
    });
    expect((created as unknown as { enabledChecks: string[] }).enabledChecks).toContain('seo');
  });

  it('shows what is wrong next to the fields and puts focus on the first one', async () => {
    const api = fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/websites/new');

    await user.click(await screen.findByRole('button', { name: 'Add website' }));

    expect(
      await screen.findByText('Give the website a name, for example the client or brand.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Enter a full site address, for example https://www.example.com.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(api.callsTo('POST', '/websites')).toHaveLength(0);
  });

  it('checks the sample size, the fixed page list and the recipients', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/websites/new');

    await user.type(await screen.findByLabelText('Name'), 'Site');
    await user.type(screen.getByLabelText('Address'), 'https://www.example.com');
    await user.clear(screen.getByLabelText('Number of pages'));
    await user.type(screen.getByLabelText('Number of pages'), '0');
    await user.type(screen.getByLabelText('Recipient email 1'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Add website' }));
    expect(await screen.findByText('Enter a whole number from 1 to 100.')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /^A fixed list of pages/ }));
    await user.click(screen.getByRole('button', { name: 'Add website' }));
    expect(
      await screen.findByText('Add at least one page, or choose another way to pick pages.'),
    ).toBeInTheDocument();
  });

  it('only shows the fields that belong to the chosen schedule', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/websites/new');
    await screen.findByLabelText('How often');

    // Weekly is the default.
    expect(screen.getByLabelText('On')).toBeInTheDocument();
    expect(screen.queryByLabelText('On day')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('How often'), 'daily');
    expect(screen.queryByLabelText('On')).not.toBeInTheDocument();
    expect(screen.getByLabelText('At (UTC)')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('How often'), 'manual');
    expect(screen.queryByLabelText('At (UTC)')).not.toBeInTheDocument();
  });

  it('puts a server refusal next to the address, such as a domain that is not allowed', async () => {
    fakeApi(
      routes({
        'POST /websites': () =>
          apiError(
            403,
            'forbidden',
            'www.nope.com is not on the allowed domains list. Ask an admin to add it in Settings, then try again.',
            { hostname: 'www.nope.com' },
          ),
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/new');
    await user.type(await screen.findByLabelText('Name'), 'Nope');
    await user.type(screen.getByLabelText('Address'), 'https://www.nope.com');
    await user.click(screen.getByRole('button', { name: 'Add website' }));

    expect(await screen.findByText(/is not on the allowed domains list/)).toBeInTheDocument();
    expect(screen.getByLabelText('Address')).toHaveAttribute('aria-invalid', 'true');
    expect(location()).toBe('/websites/new');
  });

  it('maps the problems the server found in the whole configuration onto fields', async () => {
    fakeApi(
      routes({
        'POST /websites': () =>
          apiError(422, 'validation_error', 'The website is not valid.', {
            problems: [
              {
                field: 'pinnedPageUrls',
                message: 'Every page must be on https://www.example.com.',
              },
            ],
          }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/new');
    await user.type(await screen.findByLabelText('Name'), 'Site');
    await user.type(screen.getByLabelText('Address'), 'https://www.example.com');
    await user.click(screen.getByRole('button', { name: 'Add website' }));
    expect(
      await screen.findByText('Every page must be on https://www.example.com.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Pages to always include (optional)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('does not offer to submit real forms without the permission for it', async () => {
    fakeApi(
      routes({
        'GET /auth/me': () => ({ ...session(), scopes: ['scans:read', 'scans:write'] }),
      }),
    );
    renderApp('/websites/new');
    const radio = await screen.findByRole('radio', { name: /^Submit test data/ });
    expect(radio).toBeDisabled();
    expect(screen.getByText(/Needs the forms:submit permission/)).toBeInTheDocument();
  });
});

describe('editing a website', () => {
  it('starts from the current settings and saves only the website, not its recipients', async () => {
    let patched: Record<string, unknown> | null = null;
    const current = website({
      id: 'web_a',
      name: 'Example Estates',
      checkFrequency: 'weekly',
      scheduleDayOfWeek: 3,
      scheduleDayOfMonth: null,
      pinnedPageUrls: ['https://www.example-estates.co.uk/contact'],
    });
    const api = fakeApi(
      routes({
        'GET /websites/:id': () => current,
        'PATCH /websites/:id': (request: { body: unknown }) => {
          patched = request.body as Record<string, unknown>;
          return { ...current, name: 'Renamed' };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/websites/web_a/edit');

    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Example Estates');
    expect(screen.getByLabelText('How often')).toHaveValue('weekly');
    expect(screen.getByLabelText('On')).toHaveValue('3');
    expect(screen.getByLabelText('Pages to always include (optional)')).toHaveValue(
      'https://www.example-estates.co.uk/contact',
    );
    expect(screen.queryByLabelText('Recipient email 1')).not.toBeInTheDocument();

    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(location()).toBe('/websites/web_a'));
    expect(api.callsTo('PATCH', '/websites/web_a')).toHaveLength(1);
    expect(patched).toMatchObject({
      name: 'Renamed',
      checkFrequency: 'weekly',
      scheduleDayOfWeek: 3,
      scheduleDayOfMonth: null,
    });
    expect(patched).not.toHaveProperty('recipients');
  });

  it('says so when the website does not exist', async () => {
    fakeApi(
      routes({
        'GET /websites/:id': () => apiError(404, 'not_found', 'Website web_x was not found.'),
      }),
    );
    renderApp('/websites/web_x/edit');
    expect(await screen.findByText('Website not found')).toBeInTheDocument();
  });
});
