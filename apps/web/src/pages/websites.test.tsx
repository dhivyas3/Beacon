import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { pageOf, session, website } from '@/test/builders';
import { apiError, fakeApi } from '@/test/fake-api';
import { renderApp } from '@/test/render';

const location = () => screen.getByTestId('location').textContent;

const rowFor = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement;

describe('websites list', () => {
  it('lists every website with its status, schedule, score and recipients', async () => {
    fakeApi({
      'GET /auth/me': () => session(),
      'GET /websites': () =>
        pageOf([
          website({ id: 'web_a', name: 'Example Estates' }),
          website({
            id: 'web_b',
            name: 'Paused shop',
            hostname: 'shop.example.com',
            isActive: false,
            checkFrequency: 'weekly',
            scheduleDayOfWeek: 1,
            scheduleDayOfMonth: null,
            latest: null,
            recipients: [],
            emailEnabled: false,
            pageSelectionMode: 'full',
          }),
        ]),
    });
    renderApp('/websites');

    const first = within(await waitForRow('Example Estates'));
    expect(first.getByText('Active')).toBeInTheDocument();
    expect(first.getByText(/Monthly on the 1st at 06:00 UTC/)).toBeInTheDocument();
    expect(first.getByText('8 random pages, homepage always included')).toBeInTheDocument();
    expect(first.getByLabelText('Health score 94 out of 100, Good')).toBeInTheDocument();

    const second = within(rowFor('Paused shop'));
    expect(second.getByText('Paused')).toBeInTheDocument();
    expect(second.getByText(/Weekly on Monday/)).toBeInTheDocument();
    expect(second.getByText('Never')).toBeInTheDocument();
    expect(second.getByText('Off')).toBeInTheDocument();
  });

  it('opens a website from its row', async () => {
    fakeApi({
      'GET /auth/me': () => session(),
      'GET /websites': () => pageOf([website({ id: 'web_a' })]),
      'GET /websites/:id': () => website({ id: 'web_a' }),
      'GET /websites/:id/history': () => pageOf([]),
      'GET /websites/:id/email-deliveries': () => pageOf([]),
    });
    const user = userEvent.setup();
    renderApp('/websites');
    await waitForRow('Example Estates');
    await user.click(within(rowFor('Example Estates')).getByText('Active'));
    await waitFor(() => expect(location()).toBe('/websites/web_a'));
  });

  it('searches, and offers a way back when nothing matches', async () => {
    const api = fakeApi({
      'GET /auth/me': () => session(),
      'GET /websites': (request) =>
        request.query.get('q') === 'zzz' ? pageOf([]) : pageOf([website()]),
    });
    const user = userEvent.setup();
    renderApp('/websites');
    await waitForRow('Example Estates');

    await user.type(screen.getByLabelText('Search websites'), 'zzz');
    expect(await screen.findByText('No websites match your search')).toBeInTheDocument();
    expect(api.calls.some((call) => call.query.get('q') === 'zzz')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitForRow('Example Estates');
  });

  it('shows an empty state with a way to add the first website', async () => {
    fakeApi({ 'GET /auth/me': () => session(), 'GET /websites': () => pageOf([]) });
    renderApp('/websites');
    expect(await screen.findByText('No websites yet')).toBeInTheDocument();
    const add = screen.getAllByRole('link', { name: 'Add website' });
    expect(add.length).toBeGreaterThan(0);
  });

  it('explains a failure', async () => {
    fakeApi({
      'GET /auth/me': () => session(),
      'GET /websites': () => apiError(500, 'internal_error', 'The server had a problem.'),
    });
    renderApp('/websites');
    expect(await screen.findByText('Could not load websites')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

async function waitForRow(name: string): Promise<HTMLElement> {
  const link = await screen.findByRole('link', { name });
  return link.closest('tr') as HTMLElement;
}
