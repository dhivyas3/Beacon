import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, fakeApi, type FakeRequest } from '@/test/fake-api';
import { apiKey, domain, pageOf, session, settings } from '@/test/builders';
import { renderApp } from '@/test/render';

const base = (role: 'admin' | 'member' = 'admin') => ({
  'GET /auth/me': () => session(role),
  'GET /scans': () => pageOf([]),
  'GET /settings': () => settings(),
});

describe('API keys', () => {
  it('lists keys with their fingerprint, permissions and last use, and never a full key', async () => {
    fakeApi({
      ...base(),
      'GET /api-keys': () => ({
        items: [
          apiKey({ id: 'key_1', name: 'n8n production', prefix: 'qah_7Hk2mP9x' }),
          apiKey({
            id: 'key_2',
            name: 'Old CI',
            prefix: 'qah_Old1',
            revokedAt: '2026-09-10T09:00:00.000Z',
          }),
          apiKey({ id: 'key_3', name: 'Fresh', prefix: 'qah_Frs2', lastUsedAt: null }),
        ],
      }),
    });
    renderApp('/settings');
    const table = await screen.findByRole('table', { name: 'API keys' });
    expect(
      within(table).getByText('n8n production', { selector: 'span.font-medium' }),
    ).toBeInTheDocument();
    expect(within(table).getByText('qah_7Hk2mP9x…')).toBeInTheDocument();
    expect(within(table).getAllByText('scans:write').length).toBeGreaterThan(0);
    expect(within(table).getByText('Revoked')).toBeInTheDocument();
    expect(within(table).getByText('Never')).toBeInTheDocument();
    // Revoked keys cannot be revoked again.
    expect(within(table).getAllByRole('button', { name: /^Revoke/ })).toHaveLength(2);
  });

  it('invites creating the first key when there are none', async () => {
    fakeApi({ ...base(), 'GET /api-keys': () => ({ items: [] }) });
    renderApp('/settings');
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create your first key' })).toBeInTheDocument();
  });

  it('creates a key and shows it once, with a copy button', async () => {
    let items = [apiKey({ id: 'key_1' })];
    const api = fakeApi({
      ...base(),
      'GET /api-keys': () => ({ items }),
      'POST /api-keys': (request: FakeRequest) => {
        const body = request.body as { name: string; scopes: string[] };
        const created = apiKey({
          id: 'key_new',
          name: body.name,
          scopes: body.scopes as never,
          prefix: 'qah_Zz9',
        });
        items = [created, ...items];
        return { status: 201, body: { ...created, key: 'qah_Zz9SECRETSECRETSECRET' } };
      },
    });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp('/settings');

    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create an API key' });
    const submit = within(dialog).getByRole('button', { name: 'Create key' });
    expect(submit).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Name'), 'GitHub Actions');
    await user.click(within(dialog).getByRole('checkbox', { name: /forms:submit/ }));
    await user.click(submit);

    await waitFor(() => expect(api.callsTo('POST', '/api-keys')).toHaveLength(1));
    expect(api.callsTo('POST', '/api-keys')[0]?.body).toEqual({
      name: 'GitHub Actions',
      scopes: ['scans:read', 'scans:write', 'forms:submit'],
    });

    const shown = await screen.findByRole('dialog', { name: 'Copy your new API key' });
    expect(within(shown).getByText('This is the only time the key is shown')).toBeInTheDocument();
    expect(within(shown).getByLabelText('API key')).toHaveValue('qah_Zz9SECRETSECRETSECRET');

    await user.click(within(shown).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('qah_Zz9SECRETSECRETSECRET'));

    await user.click(within(shown).getByRole('button', { name: 'I have saved it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The list now has the key, but only by its fingerprint.
    expect(
      await screen.findByText('GitHub Actions', { selector: 'span.font-medium' }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('SECRETSECRET');
  });

  it('requires at least one permission', async () => {
    fakeApi({ ...base(), 'GET /api-keys': () => ({ items: [] }) });
    const user = userEvent.setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('button', { name: 'Create your first key' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'x');
    await user.click(within(dialog).getByRole('checkbox', { name: /scans:read/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /scans:write/ }));
    expect(within(dialog).getByRole('button', { name: 'Create key' })).toBeDisabled();
  });

  it('revokes a key after confirmation', async () => {
    let items = [apiKey({ id: 'key_1', name: 'n8n production' })];
    const api = fakeApi({
      ...base(),
      'GET /api-keys': () => ({ items }),
      'DELETE /api-keys/:id': () => {
        items = items.map((item) => ({ ...item, revokedAt: '2026-09-20T09:00:00.000Z' }));
        return { status: 204 };
      },
    });
    const user = userEvent.setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('button', { name: /Revoke n8n production/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Revoke this API key?' });
    expect(
      within(dialog).getByText(/Anything using "n8n production" stops working immediately/),
    ).toBeInTheDocument();
    expect(api.callsTo('DELETE', '/api-keys/key_1')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => expect(api.callsTo('DELETE', '/api-keys/key_1')).toHaveLength(1));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(await screen.findByText('API key revoked')).toBeInTheDocument();
  });

  it('shows an error with a retry when keys cannot be loaded', async () => {
    let fail = true;
    fakeApi({
      ...base(),
      'GET /api-keys': () =>
        fail ? apiError(403, 'forbidden', 'Only admins can do that.') : { items: [] },
    });
    const user = userEvent.setup();
    renderApp('/settings');
    expect(await screen.findByText('Could not load API keys')).toBeInTheDocument();
    expect(screen.getByText('Only admins can do that.')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
  });
});

describe('allowed domains', () => {
  const open = async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('tab', { name: 'Allowed domains' }));
    return user;
  };

  it('adds a domain and clears the form', async () => {
    let items = [domain({ id: 'dom_1', hostname: '*.example.com', note: 'Client site' })];
    const api = fakeApi({
      ...base(),
      'GET /api-keys': () => ({ items: [] }),
      'GET /allowed-domains': () => ({ items }),
      'POST /allowed-domains': (request: FakeRequest) => {
        const body = request.body as { hostname: string; note?: string };
        const created = domain({ id: 'dom_2', hostname: body.hostname, note: body.note ?? null });
        items = [...items, created];
        return { status: 201, body: created };
      },
    });
    const user = await open();
    expect(await screen.findByText('*.example.com')).toBeInTheDocument();
    expect(screen.getByText('Client site')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Hostname'), 'shop.acme.test');
    await user.type(screen.getByLabelText('Note (optional)'), 'Launch');
    await user.click(screen.getByRole('button', { name: 'Allow domain' }));

    await waitFor(() => expect(api.callsTo('POST', '/allowed-domains')).toHaveLength(1));
    expect(api.callsTo('POST', '/allowed-domains')[0]?.body).toEqual({
      hostname: 'shop.acme.test',
      note: 'Launch',
    });
    expect(await screen.findByText('shop.acme.test can now be scanned')).toBeInTheDocument();
    expect(screen.getByLabelText('Hostname')).toHaveValue('');
    expect(await screen.findAllByText('shop.acme.test')).not.toHaveLength(0);
  });

  it('explains a duplicate instead of adding it twice, and clears the error when typing', async () => {
    fakeApi({
      ...base(),
      'GET /api-keys': () => ({ items: [] }),
      'GET /allowed-domains': () => ({ items: [domain({ hostname: 'example.com' })] }),
      'POST /allowed-domains': () =>
        apiError(409, 'conflict', 'example.com is already on the allowed list.'),
    });
    const user = await open();
    await user.type(await screen.findByLabelText('Hostname'), 'example.com');
    await user.click(screen.getByRole('button', { name: 'Allow domain' }));

    const message = await screen.findByText('example.com is already on the allowed list.');
    expect(message).toBeInTheDocument();
    expect(screen.getByLabelText('Hostname')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Hostname')).toHaveValue('example.com');

    await user.type(screen.getByLabelText('Hostname'), 'x');
    expect(
      screen.queryByText('example.com is already on the allowed list.'),
    ).not.toBeInTheDocument();
  });

  it('cannot submit an empty hostname', async () => {
    fakeApi({
      ...base(),
      'GET /api-keys': () => ({ items: [] }),
      'GET /allowed-domains': () => ({ items: [] }),
    });
    await open();
    expect(await screen.findByText('No domains allowed yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow domain' })).toBeDisabled();
  });

  it('removes a domain after confirmation, and keeps it when declined', async () => {
    let items = [domain({ id: 'dom_1', hostname: 'staging.acme.test' })];
    const api = fakeApi({
      ...base(),
      'GET /api-keys': () => ({ items: [] }),
      'GET /allowed-domains': () => ({ items }),
      'DELETE /allowed-domains/:id': () => {
        items = [];
        return { status: 204 };
      },
    });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Remove staging.acme.test' }));
    let dialog = await screen.findByRole('dialog', { name: 'Remove this domain?' });
    expect(
      within(dialog).getByText(/New scans of staging.acme.test will be refused/),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Keep domain' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.callsTo('DELETE', '/allowed-domains/dom_1')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Remove staging.acme.test' }));
    dialog = await screen.findByRole('dialog', { name: 'Remove this domain?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove domain' }));
    await waitFor(() => expect(api.callsTo('DELETE', '/allowed-domains/dom_1')).toHaveLength(1));
    expect(await screen.findByText('No domains allowed yet')).toBeInTheDocument();
  });
});

describe('webhook secret', () => {
  it('shows only a preview until revealed, then can be copied and hidden again', async () => {
    const api = fakeApi({
      ...base(),
      'GET /api-keys': () => ({ items: [] }),
      'GET /settings/webhook-secret': () => ({ secret: 'whsec_full_secret_value' }),
    });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp('/settings');
    await user.click(await screen.findByRole('tab', { name: 'Webhooks' }));

    const field = await screen.findByLabelText('Webhook signing secret');
    expect(field).toHaveValue('••••••••cdef');
    expect(api.callsTo('GET', '/settings/webhook-secret')).toHaveLength(0);
    expect(screen.getByText(/X-QAHub-Signature/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    await waitFor(() => expect(field).toHaveValue('whsec_full_secret_value'));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('whsec_full_secret_value'));

    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(field).toHaveValue('••••••••cdef');
  });
});

describe('scan defaults', () => {
  it('loads the saved defaults and saves changes', async () => {
    const api = fakeApi({
      ...base(),
      'GET /api-keys': () => ({ items: [] }),
      'PATCH /settings': (request: FakeRequest) => ({ ...settings(), ...(request.body as object) }),
    });
    const user = userEvent.setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('tab', { name: 'Scan defaults' }));

    expect(await screen.findByLabelText('Test email for forms')).toHaveValue('qa-test@example.com');
    expect(screen.getByLabelText('Staging host patterns')).toHaveValue('staging.\n.netlify.app');

    await user.clear(screen.getByLabelText('Test email for forms'));
    await user.type(screen.getByLabelText('Test email for forms'), 'qa@acme.test');
    await user.click(screen.getByRole('checkbox', { name: 'Page health' }));
    await user.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(api.callsTo('PATCH', '/settings')).toHaveLength(1));
    expect(api.callsTo('PATCH', '/settings')[0]?.body).toMatchObject({
      formTestEmail: 'qa@acme.test',
      defaultChecks: ['images', 'links', 'staging-urls'],
      stagingPatterns: ['staging.', '.netlify.app'],
    });
    expect(await screen.findByText('Defaults saved')).toBeInTheDocument();
  });

  it('will not save with no checks selected', async () => {
    fakeApi({ ...base(), 'GET /api-keys': () => ({ items: [] }) });
    const user = userEvent.setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('tab', { name: 'Scan defaults' }));
    await screen.findByLabelText('Test email for forms');
    for (const name of ['Images', 'Links', 'Staging URLs', 'Page health']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    expect(screen.getByText('Pick at least one check.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save defaults' })).toBeDisabled();
  });
});

describe('a member without admin rights', () => {
  it('only sees the defaults, read-only, with a note explaining why', async () => {
    const api = fakeApi(base('member'));
    renderApp('/settings');

    expect(await screen.findByText('Some settings are for admins')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'API keys' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Allowed domains' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Webhooks' })).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Test email for forms')).toBeDisabled();
    expect(screen.getByText('Only admins can change the defaults.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save defaults' })).not.toBeInTheDocument();
    expect(api.callsTo('GET', '/api-keys')).toHaveLength(0);
  });
});
