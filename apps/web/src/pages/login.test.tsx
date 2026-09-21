import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, fakeApi } from '@/test/fake-api';
import { pageOf, session, settings } from '@/test/builders';
import { renderApp } from '@/test/render';

const location = () => screen.getByTestId('location').textContent;

const signedOut = () => ({
  'GET /auth/me': () => apiError(401, 'unauthorized', 'Sign in to continue.'),
});
const signedIn = () => ({
  'GET /auth/me': () => session(),
  'GET /scans': () => pageOf([]),
  'GET /websites': () => pageOf([]),
  'GET /settings': () => settings(),
});

describe('signing in', () => {
  it('sends people who are not signed in to the login page, and remembers where they were going', async () => {
    fakeApi(signedOut());
    renderApp('/scans/scn_000000000009');
    await screen.findByRole('heading', { name: 'Sign in to Beacon' });
    expect(location()).toBe('/login?next=%2Fscans%2Fscn_000000000009');
  });

  it('signs in and continues to the page they wanted', async () => {
    const api = fakeApi({
      ...signedOut(),
      'POST /auth/login': () => session(),
      'GET /scans/:id': () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'Scan scn_9 was not found.' } },
      }),
    });
    const user = userEvent.setup();
    renderApp('/login?next=%2Fscans%2Fscn_9');

    const submit = await screen.findByRole('button', { name: 'Sign in' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Email'), 'dana@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(submit);

    await waitFor(() => expect(location()).toBe('/scans/scn_9'));
    expect(api.callsTo('POST', '/auth/login')[0]?.body).toEqual({
      email: 'dana@example.com',
      password: 'correct-horse-battery',
    });
    await screen.findByText('Scan not found');
  });

  it('says what went wrong when the password is wrong, and stays on the page', async () => {
    fakeApi({
      ...signedOut(),
      'POST /auth/login': () =>
        apiError(
          401,
          'unauthorized',
          'The email or password is incorrect. Check them and try again.',
        ),
    });
    const user = userEvent.setup();
    renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'dana@example.com');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The email or password is incorrect.',
    );
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(location()).toBe('/login');
  });

  it('never follows a redirect to another site', async () => {
    fakeApi({
      ...signedOut(),
      'POST /auth/login': () => session(),
      'GET /scans': () => pageOf([]),
      'GET /settings': () => settings(),
    });
    const user = userEvent.setup();
    renderApp('/login?next=%2F%2Fevil.example');
    await user.type(await screen.findByLabelText('Email'), 'dana@example.com');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(location()).toBe('/'));
  });

  it('skips the login page when already signed in', async () => {
    fakeApi(signedIn());
    renderApp('/login');
    await waitFor(() => expect(location()).toBe('/'));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('signs out from the account menu', async () => {
    const api = fakeApi({ ...signedIn(), 'POST /auth/logout': () => ({ status: 204 }) });
    const user = userEvent.setup();
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'Account menu for Dana' }));
    expect(screen.getByText('dana@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(location()).toBe('/login'));
    expect(api.callsTo('POST', '/auth/logout')).toHaveLength(1);
  });

  it('returns to the login page when the session ends while using the app', async () => {
    const api = fakeApi(signedIn());
    renderApp('/scans');
    await screen.findByRole('heading', { name: 'Scans' });

    // The session expires. The next request the app makes comes back 401.
    api.on('GET /auth/me', () => apiError(401, 'unauthorized', 'Sign in to continue.'));
    api.on('GET /scans', () => apiError(401, 'unauthorized', 'Sign in to continue.'));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search sites'), 'x');
    await waitFor(() => expect(location()).toMatch(/^\/login/), { timeout: 4000 });
  });
});
