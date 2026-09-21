import { verifyRecipientToken, NOTIFY_PREFERENCES, type NotifyPreference } from '@beacon/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * The pages behind the "Manage email preferences" and "Unsubscribe" links in a report email.
 *
 * They need no login: the token in the link names the recipient and carries a signature, so it can
 * act for that person only. Every page is plain HTML with no script, and a link that only reads
 * (a GET) never changes anything, because mail scanners open every link in a message. Changing a
 * preference is a POST from the page's own form.
 */

type Choice = NotifyPreference | 'unsubscribe';
const CHOICES: readonly Choice[] = [...NOTIFY_PREFERENCES, 'unsubscribe'];

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const PAGE_STYLE = `
  body{margin:0;background:#f4f4f5;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b}
  main{max-width:520px;margin:48px auto;padding:0 16px}
  .card{background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .brand{font-weight:700;font-size:18px;margin-bottom:18px}.brand span{color:#4f46e5}
  h1{font-size:20px;line-height:1.3;margin:0 0 6px}p{margin:0 0 14px;color:#52525b}
  .who{color:#18181b;font-weight:600}
  label.choice{display:flex;gap:12px;align-items:flex-start;border:1px solid #e4e4e7;border-radius:10px;padding:12px 14px;margin:0 0 10px;cursor:pointer}
  label.choice:has(input:checked){border-color:#4f46e5;background:#eef2ff}
  label.choice input{margin-top:4px}label.choice strong{display:block;color:#18181b}label.choice small{color:#71717a}
  button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:11px 20px;font:600 15px inherit;cursor:pointer;margin-top:8px}
  button:hover{background:#4338ca}
  .ok{background:#f0fdf4;color:#15803d;border-radius:8px;padding:12px 14px;margin:0 0 16px}
  a{color:#4338ca}.foot{margin-top:18px;font-size:13px;color:#71717a}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" /><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head>
<body><main><div class="card"><div class="brand"><span>&#9679;</span>&nbsp;Beacon</div>${body}</div></main></body></html>`;
}

const OPTIONS: Record<Choice, { title: string; hint: string }> = {
  every_check: { title: 'Every report', hint: 'An email after every completed check.' },
  new_issues_only: {
    title: 'Only when something new needs attention',
    hint: 'Skipped when a check finds nothing new and the score has not dropped.',
  },
  unsubscribe: {
    title: 'Stop these emails',
    hint: 'You will not get reports for this website any more.',
  },
};

function current(isActive: boolean, notify: NotifyPreference): Choice {
  return isActive ? notify : 'unsubscribe';
}

function form(action: string, selected: Choice): string {
  return `<form method="post" action="${esc(action)}">
    ${CHOICES.map(
      (choice) =>
        `<label class="choice"><input type="radio" name="choice" value="${choice}"${
          choice === selected ? ' checked' : ''
        } /><span><strong>${esc(OPTIONS[choice].title)}</strong><small>${esc(OPTIONS[choice].hint)}</small></span></label>`,
    ).join('')}
    <button type="submit">Save</button></form>`;
}

const NOT_FOUND = page(
  'Link not valid',
  `<h1>This link is not valid</h1><p>It may have been copied incompletely. Open the link from the most recent report email, or ask whoever manages the website to change it for you.</p>`,
);

export const emailPreferenceRoutes: FastifyPluginAsyncZod = async (app) => {
  // The page's own form posts URL-encoded fields, and mail clients send a form body to the
  // one-click unsubscribe address as well. Fastify does not read that content type by default.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  const secret = app.config.WEBHOOK_SIGNING_SECRET;

  async function load(token: string) {
    const recipientId = await verifyRecipientToken(secret, token);
    if (recipientId === null) return null;
    return app.db.websiteRecipient.findUnique({
      where: { id: recipientId },
      include: { website: { select: { name: true } } },
    });
  }

  const headers = (reply: { header: (name: string, value: string) => unknown }): void => {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    reply.header('content-type', 'text/html; charset=utf-8');
  };

  const TokenParams = z.object({ token: z.string().min(1).max(200) });

  app.get(
    '/email/preferences/:token',
    {
      config: { auth: false },
      schema: {
        hide: true,
        params: TokenParams,
        querystring: z.object({
          choice: z.enum(['every_check', 'new_issues_only', 'unsubscribe']).optional(),
        }),
      },
    },
    async (request, reply) => {
      headers(reply);
      const recipient = await load(request.params.token);
      if (!recipient) return reply.code(404).send(NOT_FOUND);
      const selected = request.query.choice ?? current(recipient.isActive, recipient.notify);
      return reply.send(
        page(
          'Email preferences',
          `<h1>Email preferences</h1>
           <p>Health reports for <strong>${esc(recipient.website.name)}</strong>, sent to <span class="who">${esc(recipient.email)}</span>.</p>
           ${form(`/api/v1/email/preferences/${request.params.token}`, selected)}
           <p class="foot">Changing this only affects your address. The website's schedule is managed by its owner.</p>`,
        ),
      );
    },
  );

  app.post(
    '/email/preferences/:token',
    {
      config: { auth: false },
      schema: {
        hide: true,
        params: TokenParams,
        body: z.object({ choice: z.enum(['every_check', 'new_issues_only', 'unsubscribe']) }),
      },
    },
    async (request, reply) => {
      headers(reply);
      const recipient = await load(request.params.token);
      if (!recipient) return reply.code(404).send(NOT_FOUND);
      const { choice } = request.body;
      await app.db.websiteRecipient.update({
        where: { id: recipient.id },
        data: choice === 'unsubscribe' ? { isActive: false } : { isActive: true, notify: choice },
      });
      const message =
        choice === 'unsubscribe'
          ? `You will no longer receive health reports for ${esc(recipient.website.name)} at ${esc(recipient.email)}.`
          : `Saved. ${esc(OPTIONS[choice].title)} for ${esc(recipient.website.name)}.`;
      return reply.send(
        page(
          'Preferences saved',
          `<div class="ok">${message}</div>
           <p>Changed your mind? <a href="/api/v1/email/preferences/${esc(request.params.token)}">Change your preference</a>.</p>`,
        ),
      );
    },
  );

  // The address named in the List-Unsubscribe header. A mail client posts here with no page in
  // between (RFC 8058), which is what lets it show its own "Unsubscribe" button.
  app.post(
    '/email/preferences/:token/unsubscribe',
    {
      config: { auth: false },
      schema: { hide: true, params: TokenParams },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const recipient = await load(request.params.token);
      if (!recipient) return reply.code(404).type('text/plain').send('Not found');
      await app.db.websiteRecipient.update({
        where: { id: recipient.id },
        data: { isActive: false },
      });
      return reply.type('text/plain').send('Unsubscribed');
    },
  );
};
