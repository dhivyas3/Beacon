import { vi } from 'vitest';

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  params: Record<string, string>;
  headers: Record<string, string>;
}

/** A `Response`, `{ status, body }`, or any value, which is sent as a 200 JSON body. */
type Reply = unknown;
type Handler = (request: FakeRequest) => unknown;

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

export function apiError(status: number, code: string, message: string, details?: unknown) {
  return json(status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
}

function compile(pattern: string): { method: string; regex: RegExp; names: string[] } {
  const [method, path] = pattern.split(' ') as [string, string];
  const names: string[] = [];
  const source = path.replace(/:([a-zA-Z]+)/g, (_match, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { method, regex: new RegExp(`^${source}$`), names };
}

function toResponse(reply: Reply): Response {
  if (reply instanceof Response) return reply;
  if (reply && typeof reply === 'object' && 'status' in reply && typeof reply.status === 'number') {
    const { status, body } = reply as { status: number; body?: unknown };
    return json(status, body);
  }
  return json(200, reply);
}

/**
 * Replaces `fetch` with an in-memory API. Keys look like `GET /scans/:id`. Every request is
 * recorded in `calls`, and requests nobody handles answer 404 so a forgotten route fails loudly.
 */
export function fakeApi(handlers: Record<string, Handler>) {
  const routes = new Map(
    Object.entries(handlers).map(([key, handler]) => [key, { ...compile(key), handler }]),
  );
  const calls: FakeRequest[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;

    for (const route of routes.values()) {
      if (route.method !== method) continue;
      const match = route.regex.exec(path);
      if (!match) continue;
      const params = Object.fromEntries(
        route.names.map((name, index) => [name, match[index + 1] ?? '']),
      );
      const request: FakeRequest = { method, path, query: url.searchParams, body, params, headers };
      calls.push(request);
      return toResponse(await route.handler(request));
    }
    calls.push({ method, path, query: url.searchParams, body, params: {}, headers });
    return apiError(404, 'not_found', `No fake route for ${method} ${path}`);
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    calls,
    /** Requests that matched `method path`, for example `callsTo('POST', '/scans')`. */
    callsTo: (method: string, path: string) =>
      calls.filter((call) => call.method === method && call.path === path),
    /** Adds or replaces a route after the fact. */
    on(key: string, handler: Handler): void {
      routes.set(key, { ...compile(key), handler });
    },
  };
}
