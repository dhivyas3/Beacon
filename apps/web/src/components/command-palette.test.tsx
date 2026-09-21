import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { detail, pageOf, session, website } from '@/test/builders';
import { apiError, fakeApi } from '@/test/fake-api';
import { renderApp } from '@/test/render';

const location = () => screen.getByTestId('location').textContent;

function routes(extra: Record<string, (request: never) => unknown> = {}) {
  return {
    'GET /auth/me': () => session(),
    'GET /websites': () => pageOf([website({ id: 'web_a', name: 'Example Estates' })]),
    'GET /scans': () => pageOf([]),
    'GET /settings': () => ({}),
    ...extra,
  };
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Overview' });
  await user.keyboard('{Control>}k{/Control}');
  return screen.findByRole('combobox', { name: 'Search commands' });
}

describe('command palette', () => {
  it('opens with Ctrl+K with focus in the search box, and closes with Escape', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/');
    const input = await openPalette(user);
    expect(input).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens from the button in the header too', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(screen.getByRole('button', { name: 'Search and run commands' }));
    expect(await screen.findByRole('combobox', { name: 'Search commands' })).toBeInTheDocument();
  });

  it('lists pages and actions in groups, and websites once they have loaded', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/');
    await openPalette(user);
    const list = screen.getByRole('listbox', { name: 'Commands' });
    expect(within(list).getByRole('option', { name: 'Overview' })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: 'Add website' })).toBeInTheDocument();
    expect(
      await within(list).findByRole('option', { name: /Open Example Estates/ }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole('option', { name: /Check Example Estates now/ }),
    ).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('goes to a page with the keyboard alone', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/');
    await openPalette(user);
    await user.keyboard('settings{Enter}');
    await waitFor(() => expect(location()).toBe('/settings'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('moves the highlight with the arrow keys and announces it', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/');
    const input = await openPalette(user);

    const options = () => screen.getAllByRole('option');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options()[0]?.id);

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(options()[2]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options()[2]?.id);

    await user.keyboard('{ArrowUp}');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(location()).toBe('/websites'));
  });

  it('opens a website found by name or by hostname', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/');
    await openPalette(user);
    await screen.findByRole('option', { name: /Open Example Estates/ });
    await user.keyboard('example-estates');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(location()).toBe('/websites/web_a'));
  });

  it('starts a check of a website and follows it', async () => {
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
    renderApp('/');
    await openPalette(user);
    await screen.findByRole('option', { name: /Check Example Estates now/ });
    await user.keyboard('check estates{Enter}');
    await waitFor(() => expect(location()).toBe('/scans/scn_new'));
    expect(api.callsTo('POST', '/websites/web_a/check-now')).toHaveLength(1);
  });

  it('shows why a check could not start', async () => {
    fakeApi(
      routes({
        'POST /websites/:id/check-now': () =>
          apiError(409, 'conflict', 'This website already has a check running.'),
      }),
    );
    const user = userEvent.setup();
    renderApp('/');
    await openPalette(user);
    await screen.findByRole('option', { name: /Check Example Estates now/ });
    await user.keyboard('check estates{Enter}');
    expect(
      await screen.findByText('This website already has a check running.'),
    ).toBeInTheDocument();
  });

  it('changes the theme and signs out', async () => {
    const api = fakeApi(routes({ 'POST /auth/logout': () => ({ status: 204 }) }));
    const user = userEvent.setup();
    renderApp('/');
    await openPalette(user);
    await user.keyboard('dark theme{Enter}');
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'));

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('combobox', { name: 'Search commands' });
    await user.keyboard('sign out{Enter}');
    await waitFor(() => expect(location()).toBe('/login'));
    expect(api.callsTo('POST', '/auth/logout')).toHaveLength(1);
  });

  it('says when nothing matches', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/');
    await openPalette(user);
    await user.keyboard('zzzzzz');
    expect(screen.getByRole('status')).toHaveTextContent('Nothing matches');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('does not ask for websites until it is opened', async () => {
    const api = fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/scans');
    await screen.findByRole('heading', { name: 'Scans' });
    expect(api.callsTo('GET', '/websites')).toHaveLength(0);
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(api.callsTo('GET', '/websites').length).toBeGreaterThan(0));
  });
});
