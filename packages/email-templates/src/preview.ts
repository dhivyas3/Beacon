import { createServer } from 'node:http';
import { FIXTURES, type FixtureName } from './fixtures.js';
import { renderEmail, esc } from './render.js';

/**
 * A local page for looking at the emails, with no mail sent. It renders each sample from
 * fixtures.ts on every request, and `pnpm email:preview` runs it under `tsx watch`, so saving a
 * template file restarts it and a browser refresh shows the change.
 */

const port = Number(process.env.EMAIL_PREVIEW_PORT ?? 4020);
const names = Object.keys(FIXTURES) as FixtureName[];

function isFixture(name: string): name is FixtureName {
  return (names as string[]).includes(name);
}

async function indexPage(): Promise<string> {
  const cards = await Promise.all(
    names.map(async (name) => {
      const email = await renderEmail(FIXTURES[name]);
      return `<section>
        <header>
          <h2>${esc(name)} <small>${esc(email.variant.replace('_', ' '))}</small></h2>
          <p class="subject">${esc(email.subject)}</p>
          <p class="pre">${esc(email.preheader)}</p>
          <p><a href="/email/${name}" target="_blank">Open</a> · <a href="/email/${name}/text" target="_blank">Plain text</a></p>
        </header>
        <iframe src="/email/${name}" title="${esc(name)}" loading="lazy"></iframe>
      </section>`;
    }),
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Beacon email preview</title>
    <style>
      body{margin:0;background:#e4e4e7;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b}
      main{max-width:1400px;margin:0 auto;padding:24px}
      h1{font-size:20px;margin:0 0 4px} .lead{color:#52525b;margin:0 0 20px}
      .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(640px,1fr));gap:20px}
      section{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.08)}
      header{padding:14px 16px;border-bottom:1px solid #e4e4e7}
      h2{margin:0;font-size:15px} h2 small{color:#71717a;font-weight:500;margin-left:6px;text-transform:uppercase;font-size:11px;letter-spacing:.06em}
      .subject{margin:6px 0 0;font-weight:600} .pre{margin:2px 0 6px;color:#71717a} a{color:#4338ca}
      iframe{width:100%;height:900px;border:0;background:#f4f4f5}
    </style></head><body><main>
      <h1>Beacon email preview</h1>
      <p class="lead">Rendered from the sample data in <code>src/fixtures.ts</code>. Nothing is sent. Save a template file and refresh.</p>
      <div class="grid">${cards.join('')}</div>
    </main></body></html>`;
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [, kind, name, part] = url.pathname.split('/');
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(await indexPage());
        return;
      }
      if (kind === 'email' && name !== undefined && isFixture(name)) {
        const email = await renderEmail(FIXTURES[name]);
        if (part === 'text') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(email.text);
        } else {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(email.html);
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : String(error));
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Email preview: http://127.0.0.1:${port}`);
});
