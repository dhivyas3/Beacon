import { createServer, type Server } from 'node:http';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN, PORTS, WEB_URL } from '../src/stack.js';

/** The API refuses writes made with a session cookie from another origin, so say where we are. */
export const ORIGIN = { origin: WEB_URL };

type Cookies = Awaited<ReturnType<ReturnType<Page['context']>['cookies']>>;
let session: Cookies | null = null;

/**
 * Signs in through the real endpoint. The API allows ten sign-ins a minute from one address,
 * so the first call signs in and every later one reuses that session's cookie.
 */
export async function signIn(page: Page): Promise<void> {
  if (session) {
    await page.context().addCookies(session);
    return;
  }
  const response = await page.request.post('/api/v1/auth/login', {
    data: ADMIN,
    headers: ORIGIN,
  });
  expect(response.ok(), 'sign in').toBe(true);
  session = await page.context().cookies();
}

export interface WebsiteRow {
  id: string;
  name: string;
  hostname: string;
  latest: { scanId: string } | null;
}

export async function websites(request: APIRequestContext): Promise<WebsiteRow[]> {
  const response = await request.get('/api/v1/websites');
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { items: WebsiteRow[] }).items;
}

export interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A stand-in for an n8n webhook: keeps every request it is sent, and answers 200. */
export async function startReceiver(): Promise<{
  received: Received[];
  close(): Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200);
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(PORTS.receiver, '127.0.0.1', resolve));
  return {
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
