import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

export interface RecordedRequest {
  method: string;
  path: string;
  userAgent: string;
  body: string;
  /** Value of the `X-QAHub-Test` header, present on form submissions made by the forms check. */
  testHeader: string | null;
}

export interface FixtureSite {
  /** Base URL, for example `http://127.0.0.1:4123`. No trailing slash. */
  url: string;
  port: number;
  /** Every request received, in order. */
  requests: RecordedRequest[];
  /** POSTs to /api/forms/*, in order. */
  submissions: RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
}

export interface FixtureOptions {
  /** Port to listen on. Default: a free port. */
  port?: number;
  /** Base URL of the "external" site linked from the pages. */
  externalUrl?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
};

const PAGES: Record<string, string> = {
  '/': 'index.html',
  '/about': 'about.html',
  '/contact': 'contact.html',
  '/console-errors': 'console-errors.html',
  '/no-meta': 'no-meta.html',
  '/form-good': 'form-good.html',
  '/form-broken': 'form-broken.html',
  '/form-500': 'form-500.html',
  '/form-captcha': 'form-captcha.html',
  '/form-login': 'form-login.html',
  '/form-external': 'form-external.html',
  '/form-nosubmit': 'form-nosubmit.html',
  '/form-delete': 'form-delete.html',
  '/form-422': 'form-422.html',
  '/form-silent': 'form-silent.html',
  '/form-soft-error': 'form-soft-error.html',
  '/form-dead': 'form-dead.html',
  '/form-native': 'form-native.html',
  '/form-bypass': 'form-bypass.html',
  '/form-lax-email': 'form-lax-email.html',
  '/thanks': 'thanks.html',
  '/seo-bad': 'seo-bad.html',
  '/seo-dup-a': 'seo-dup-a.html',
  '/seo-dup-b': 'seo-dup-b.html',
  '/orphan': 'orphan.html',
  '/sitemap-only': 'sitemap-only.html',
};

const STATIC_FILES: Record<string, string> = {
  '/images/ok.svg': 'images/ok.svg',
  '/download.pdf': 'download.pdf',
  '/robots.txt': 'robots.txt',
  '/sitemap.xml': 'sitemap.xml',
  '/sitemap-pages.xml': 'sitemap-pages.xml',
};

function contentTypeFor(file: string): string {
  const dot = file.lastIndexOf('.');
  return CONTENT_TYPES[dot === -1 ? '' : file.slice(dot)] ?? 'application/octet-stream';
}

async function render(
  file: string,
  vars: { origin: string; external: string; n?: string },
): Promise<string> {
  const [raw, header, footer] = await Promise.all([
    readFile(join(PUBLIC_DIR, file), 'utf8'),
    readFile(join(PUBLIC_DIR, '_partials/header.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, '_partials/footer.html'), 'utf8'),
  ]);
  return raw
    .replaceAll('{{header}}', header)
    .replaceAll('{{footer}}', footer)
    .replaceAll('{{ORIGIN}}', vars.origin)
    .replaceAll('{{EXTERNAL}}', vars.external)
    .replaceAll('{{N}}', vars.n ?? '');
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
  method = 'GET',
): void {
  response.writeHead(status, headers);
  response.end(method === 'HEAD' ? undefined : body);
}

const NOT_FOUND_HTML =
  '<!doctype html><html><head><title>Not found</title></head><body><h1>Not found</h1></body></html>';

async function listen(server: Server, port?: number): Promise<number> {
  const bind = (host: string): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port ?? 0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  // Dual stack, so both http://127.0.0.1 and http://localhost work in Node and in Chromium.
  try {
    await bind('::');
  } catch {
    await bind('127.0.0.1');
  }
  return (server.address() as AddressInfo).port;
}

function closer(server: Server): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
}

/**
 * The fixture site: a small static site that deliberately contains every kind of defect QA Hub
 * looks for. Pages, and what is wrong with them, are described in fixtures/site/README.md.
 */
export async function startFixtureSite(options: FixtureOptions = {}): Promise<FixtureSite> {
  const requests: RecordedRequest[] = [];
  const submissions: RecordedRequest[] = [];
  let origin = '';
  let busyHits = 0;

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      send(res, 500, String(error));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    const body = method === 'POST' ? await readBody(req) : '';
    const record: RecordedRequest = {
      method,
      path,
      userAgent: String(req.headers['user-agent'] ?? ''),
      body,
      testHeader:
        req.headers['x-qahub-test'] === undefined ? null : String(req.headers['x-qahub-test']),
    };
    requests.push(record);
    const vars = { origin, external: options.externalUrl ?? origin };
    const html = { 'content-type': CONTENT_TYPES['.html'] as string };

    if (PAGES[path]) return send(res, 200, await render(PAGES[path], vars), html, method);

    const product = /^\/products\/(\d+)$/.exec(path);
    if (product?.[1]) {
      const n = Number(product[1]);
      if (n >= 1 && n <= 3) {
        return send(
          res,
          200,
          await render('product.html', { ...vars, n: String(n) }),
          html,
          method,
        );
      }
    }

    const file = STATIC_FILES[path];
    if (file) {
      const content =
        file.endsWith('.xml') || file.endsWith('.txt')
          ? await render(file, vars)
          : await readFile(join(PUBLIC_DIR, file));
      return send(res, 200, content, { 'content-type': contentTypeFor(file) }, method);
    }

    switch (path) {
      case '/old-page':
        return send(res, 301, '', { location: '/about' });
      case '/redirect-chain/1':
      case '/redirect-chain/2':
      case '/redirect-chain/3': {
        const next = Number(path.split('/').pop()) + 1;
        return send(res, 301, '', { location: `/redirect-chain/${next}` });
      }
      case '/redirect-chain/4':
        return send(res, 302, '', { location: '/about' });
      case '/no-head':
        return method === 'HEAD'
          ? send(res, 405, '', { allow: 'GET' })
          : send(res, 200, '<!doctype html><title>No HEAD</title><h1>No HEAD</h1>', html);
      case '/forbidden-head':
        return method === 'HEAD'
          ? send(res, 403, '')
          : send(res, 200, '<!doctype html><title>No HEAD 2</title><h1>Forbidden HEAD</h1>', html);
      case '/busy-internal':
        busyHits += 1;
        return busyHits <= 2
          ? send(res, 429, 'slow down', { 'retry-after': '0' }, method)
          : send(res, 200, '<!doctype html><title>Busy</title><h1>Busy</h1>', html, method);
      case '/api/broken':
        return send(res, 500, '{"error":"boom"}', {
          'content-type': CONTENT_TYPES['.json'] as string,
        });
      case '/api/forms/good':
      case '/api/forms/broken':
        submissions.push(record);
        return send(res, 200, '{"ok":true}', { 'content-type': CONTENT_TYPES['.json'] as string });
      case '/api/forms/422':
        submissions.push(record);
        return send(res, 422, '{"error":"email domain not accepted"}', {
          'content-type': CONTENT_TYPES['.json'] as string,
        });
      case '/api/forms/silent':
      case '/api/forms/soft-error':
        submissions.push(record);
        return send(res, 200, '{"ok":true}', { 'content-type': CONTENT_TYPES['.json'] as string });
      case '/api/forms/native':
        submissions.push(record);
        return send(res, 303, '', { location: '/thanks' });
      case '/api/forms/500':
        submissions.push(record);
        return send(res, 500, '{"error":"database is down"}', {
          'content-type': CONTENT_TYPES['.json'] as string,
        });
      default:
        return send(res, 404, NOT_FOUND_HTML, html, method);
    }
  }

  const port = await listen(server, options.port);
  origin = `http://127.0.0.1:${port}`;

  return {
    url: origin,
    port,
    requests,
    submissions,
    reset() {
      requests.length = 0;
      submissions.length = 0;
      busyHits = 0;
    },
    close: closer(server),
  };
}

/**
 * A second site on a different hostname (`localhost`), standing in for third-party links. It
 * answers 404 for /gone, rate limits /busy twice before succeeding, and blocks bots on /blocked.
 */
export async function startExternalSite(options: { port?: number } = {}): Promise<FixtureSite> {
  const requests: RecordedRequest[] = [];
  let busyHits = 0;

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://external').pathname;
    requests.push({
      method,
      path,
      userAgent: String(req.headers['user-agent'] ?? ''),
      body: '',
      testHeader: null,
    });
    const html = { 'content-type': CONTENT_TYPES['.html'] as string };
    switch (path) {
      case '/ok.html':
        return send(
          res,
          200,
          '<!doctype html><title>External</title><h1>External</h1>',
          html,
          method,
        );
      case '/busy':
        busyHits += 1;
        return busyHits <= 2
          ? send(res, 429, 'slow down', { 'retry-after': '0' }, method)
          : send(res, 200, 'ok', html, method);
      case '/blocked':
        return send(res, 403, 'bots not welcome', html, method);
      default:
        return send(res, 404, NOT_FOUND_HTML, html, method);
    }
  });

  const port = await listen(server, options.port);
  return {
    url: `http://localhost:${port}`,
    port,
    requests,
    submissions: [],
    reset() {
      requests.length = 0;
      busyHits = 0;
    },
    close: closer(server),
  };
}
