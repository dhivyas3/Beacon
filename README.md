# Beacon

Beacon keeps watch on the health of websites. Register a site once and Beacon checks it on a schedule, usually on a handful of representative pages, then reports what it found. One-off full scans, started from the dashboard, the API, n8n or monday.com, still work and are one way of triggering a check among several. Every check discovers pages, runs the checks in the background, streams progress and produces a report.

> **Status: Phase 7 of 9 (email reports and callbacks).** Registered websites are checked on a schedule and the report is emailed to their recipients, with a designed HTML email, retries and a delivery log. Scans can call a URL back, signed, when they finish. The dashboard screens for websites arrive in Phase 8, and the n8n guides and end-to-end test in Phase 9. See [docs/SPEC.md](docs/SPEC.md) for the product and [docs/PLAN.md](docs/PLAN.md) for the order of work. This README describes what exists today.

## Quick start

### With Docker

```bash
cp .env.example .env
# Set WEBHOOK_SIGNING_SECRET (openssl rand -hex 32) and SEED_ADMIN_PASSWORD in .env
docker compose up --build
docker compose exec api pnpm db:seed     # create the first admin
open http://localhost:8080               # web app
open http://localhost:8080/api/docs      # OpenAPI docs
```

### Without Docker (Windows, macOS, Linux)

Requires Node 22 and pnpm 10. Postgres 16 and Redis run from the repo, no installation needed.

```bash
pnpm install
pnpm dev:services        # embedded Postgres :5432 and Redis :6379, keep this running
cp .env.example .env
pnpm db:migrate
pnpm db:seed
pnpm dev                 # api :3000, worker, web :5173
```

Edit `.env` after copying it: set `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/beacon` and `REDIS_URL=redis://127.0.0.1:6379` (the values `pnpm dev:services` prints), `PUBLIC_URL=http://localhost:5173`, and a `SEED_ADMIN_PASSWORD` of your own. `pnpm db:migrate` and `pnpm db:seed` read the root `.env` themselves.

`pnpm dev:services` needs a `redis-server` binary. It looks for `REDIS_SERVER_BIN`, then `.tools/redis/`, then `PATH`.

The worker drives Chromium. Install it once with `pnpm --filter @beacon/worker exec playwright install chromium` (the Docker image does this for you).

### The dashboard

Open http://localhost:5173 and sign in with the seeded admin. In development the Vite server proxies `/api` to the API on `127.0.0.1:3000` (override with `VITE_API_TARGET`), so the session cookie and the CSRF check behave as they do in production.

| Screen | What it does |
| --- | --- |
| Scans | Start a scan, search and filter, see live progress for active scans, open a report |
| Scan in progress | Percentage, phase, pages per minute, elapsed time, estimated finish, and issues as they are found. Cancel with confirmation |
| Report | Health score with change since the last scan, score trend, findings by check, and issues by page or grouped across pages. Each issue has its evidence and a screenshot. Ignore or reopen issues |
| Settings | Create and revoke API keys (shown once), allowed domains, the webhook signing secret, scan defaults. Non-admins see the defaults read-only |

The dashboard follows scans by polling once a second while a scan is active. Live server-sent events replace this in Phase 6.

### Try a scan on the fixture site

The repo ships a small site with deliberate defects. It is the only thing you should scan while developing.

```bash
pnpm --filter @beacon/fixtures serve   # http://127.0.0.1:4010
# In .env set ALLOW_LOCAL_TARGETS=true, allow 127.0.0.1 (step 2 of the API walkthrough), then start a scan of http://127.0.0.1:4010
```

See [fixtures/site/README.md](fixtures/site/README.md) for what is wrong with each page.

## What each check does

| Check | Looks for |
| --- | --- |
| `images` | Broken images, missing `alt`, broken `srcset` candidates and CSS backgrounds |
| `links` | Broken, redirect-chained and unreachable links, each unique link verified once |
| `staging-urls` | Links, images, scripts, canonicals and requests that point at staging or development hosts |
| `page-health` | Non-2xx pages, console errors, uncaught exceptions, failing requests, mixed content |
| `seo` | Missing or long titles, missing description, canonical problems, `noindex`, missing h1 and `lang`, missing social tags, broken share image, duplicate titles and descriptions, pages missing from the sitemap |
| `forms` | Depends on the form mode below |

### Form modes

| Mode | What Beacon does | Sends anything? |
| --- | --- | --- |
| `detect` (default) | Reads the markup only: no submit button, a secure page posting to `http://` | No |
| `validate_only` | Also submits each form empty, and with a bad email address, in a copy of the page where every request that could send data is blocked | No, never |
| `submit` | Also fills each form with clearly marked test data and submits it once, then checks the result: server error, rejection, nothing sent, no confirmation, or an error message shown. Needs the `forms:submit` permission | Yes, once per distinct form |

Login, payment, file upload, CAPTCHA, search and third-party forms are never touched, and neither are forms with a destructive or financial button such as "Delete" or "Buy now". Each is reported as skipped with the reason. Requests Beacon sends when submitting carry an `X-Beacon-Test: form-submission` header so site owners can filter them.

## Websites and scheduled checks

A **website** is a site you monitor. It has a schedule, a page selection, a list of enabled checks, a form mode and, from Phase 7, recipients who get the report. Each execution is a **check** (stored as a scan). A scan of no website is a one-off scan and behaves exactly as before.

| Page selection | What is checked |
| --- | --- |
| `full` | Every page found by the sitemap and a crawl. The default for a one-off scan |
| `static_list` | Exactly the pages you list. No discovery |
| `random_sample` | A sample of `sampleSize` pages, always including the homepage and any pinned pages. Pages not checked before are preferred, so coverage grows check by check |

| Schedule | Meaning |
| --- | --- |
| `manual` | Only when someone asks |
| `daily` | Every day at `scheduleHourUtc` |
| `weekly` | On `scheduleDayOfWeek` (0 is Sunday) |
| `monthly` | On `scheduleDayOfMonth`, clamped to the last day of shorter months |

The worker looks for due websites every two minutes. After downtime a website is checked once, then follows its normal schedule, with no backlog.

Register one from the API (the dashboard screens arrive in Phase 8). This is "monthly, 8 random pages, homepage always included":

```bash
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
    "name": "Example Estates",
    "url": "https://www.example-estates.co.uk",
    "checkFrequency": "monthly", "scheduleDayOfMonth": 1, "scheduleHourUtc": 6,
    "pageSelectionMode": "random_sample", "sampleSize": 8,
    "pinnedPageUrls": ["https://www.example-estates.co.uk/contact/"],
    "recipients": [{"email": "owner@example-estates.co.uk"}]
  }' http://localhost:3000/api/v1/websites

# Check it now, outside the schedule
curl -s -X POST -H "Authorization: Bearer $KEY" http://localhost:3000/api/v1/websites/web_.../check-now

# Scores over time, newest first
curl -s -H "Authorization: Bearer $KEY" http://localhost:3000/api/v1/websites/web_.../history
```

`POST /scans` also accepts a `websiteId`, which inherits the website's checks, form mode and page selection unless the request overrides them. Send `"source": "n8n"` or `"monday"` so the dashboard shows where a check came from.

### Email reports

When a check of a website completes, Beacon emails a designed report to each active recipient: the health score, the trend against the last check, what is new, and a button to the full report. A check with nothing new and a score that held or improved gets a calmer green "all clear" email, and the subject line says which you have before you open it:

```
✅ example-estates.co.uk — health score 94 (no new issues)
⚠️ example-estates.co.uk — health score 61 (3 new critical issues)
🚨 example-estates.co.uk — the check could not run
```

A check that fails, for example because the site is down, emails a failure notice instead. Cancelled scans send nothing, and neither do scans that belong to no website.

Set the provider in `.env`:

| `EMAIL_PROVIDER` | Needs | Notes |
| --- | --- | --- |
| `resend` (the default when a key is set) | `RESEND_API_KEY`, `EMAIL_FROM` | Verify your sending domain in Resend first, or mail is refused |
| `smtp` | `SMTP_URL`, `EMAIL_FROM` | Any SMTP server. Postmark and Amazon SES both offer SMTP relays |
| `log` (the default with no key) | nothing | Writes each email to `data/outbox` as HTML, text and JSON. Open the HTML in a browser |

Each website has an email switch (`emailEnabled`) that keeps its recipients but stops the emails, and each recipient can choose to get every report or only reports with new issues. Every email carries links to manage that and to unsubscribe, plus the `List-Unsubscribe` headers that let Gmail and Apple Mail show their own unsubscribe button. Every send is recorded (`GET /websites/:id/email-deliveries`), transient failures are retried, and a failure shows on the website (`emailStatus`) rather than in a log.

To work on the design without sending anything:

```bash
pnpm email:preview     # http://127.0.0.1:4020, every variant from sample data, live reload
```

### Callbacks

Give `POST /scans` (or `POST /websites/:id/check-now`) a `callbackUrl` and Beacon POSTs a JSON body to it when the scan completes, fails or is cancelled. The body is signed with the webhook secret from Settings, using HMAC-SHA256 over the exact bytes sent:

```
X-Beacon-Signature: sha256=<hex>
X-Beacon-Event: scan.completed        (or scan.failed, scan.cancelled)
X-Beacon-Delivery: whd_...            (the same on every retry, so you can ignore duplicates)
X-Beacon-Attempt: 1
```

Verify it before parsing the body:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return header?.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

Any `2xx` counts as delivered. A `5xx`, `408`, `429` or a network error is retried up to six attempts, waiting 30 seconds, 2 minutes, 10 minutes, 1 hour and 6 hours. Any other status, including a `404` and a redirect (which is never followed), is final. The body has the scan's status, score, score change, counts, your `metadata` echoed back untouched, and links to the report and to the API. The schema is `CallbackPayload` in the OpenAPI document.

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    UI[Dashboard]
    N8N[n8n / monday.com]
    CI[CI pipelines]
  end
  UI & N8N & CI -->|/api/v1| API[apps/api<br/>Fastify + Zod]
  API --> PG[(PostgreSQL 16)]
  API -->|enqueue| RQ[(Redis 7<br/>BullMQ)]
  RQ --> W[apps/worker<br/>discovery, checks, callbacks]
  W --> PG
  W --> FS[(Screenshots<br/>local disk)]
  W -->|SSRF-safe HTTP + Playwright| SITE[Site being scanned]
  W -->|signed callback| N8N
  API -->|SSE progress| UI
```

| Package | Purpose |
| --- | --- |
| `apps/api` | Public `/api/v1` API, sessions and API keys, OpenAPI at `/api/docs` |
| `apps/worker` | Scan engine: discovery and page selection, browser pool, checks, link verification, progress, stale-scan reaper, , the scheduler that starts due websites, and the workers that send callbacks and emails |
| `apps/web` | React 19 dashboard: Vite, React Router, TanStack Query, Tailwind, Radix, Recharts |
| `packages/shared` | Zod schemas (the API contract), progress and ETA maths, health score, URL utilities, env parsing |
| `packages/net` | SSRF guard and the HTTP client for every user-supplied URL: DNS pinning, redirect re-checks, size and time limits |
| `packages/email-templates` | The report email: MJML template, subject lines, plain-text version and the preview server |
| `packages/storage` | Storage interface with a local disk implementation, used for screenshots |
| `fixtures/site` | Deterministic site with known defects, used by tests and for manual trials |
| `packages/db` | Prisma schema, migrations, client, admin seed |
| `packages/testkit` | Embedded Postgres, Redis and per-test databases for the test suite |

## Commands

| Command | Does |
| --- | --- |
| `pnpm build` | Build every package |
| `pnpm typecheck` | `tsc --noEmit` everywhere |
| `pnpm lint` | ESLint and Prettier check |
| `pnpm test` | Unit and integration tests (starts its own Postgres and Redis if none are configured) |
| `pnpm dev` | Watch mode for api, worker and web |
| `pnpm --filter @beacon/web test` | Web component and page tests (Vitest, Testing Library, jsdom) |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:seed` | Create the first admin from `SEED_ADMIN_*` |

## Configuration

Every variable is documented in [.env.example](.env.example).

## API walkthrough

Interactive docs live at `/api/docs` and the OpenAPI 3.1 document at `/api/docs/json`, ready to import into n8n or Postman. Set `BASE` to your deployment, for example `http://localhost:8080` with Docker or `http://localhost:3000` in dev.

```bash
BASE=http://localhost:3000

# 1. Sign in as the seeded admin (session cookie, used by the dashboard and for admin actions)
curl -s -c jar.txt -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"<SEED_ADMIN_PASSWORD>"}' $BASE/api/v1/auth/login

# 2. Allow a site. Entries starting with *. match the apex and every subdomain.
curl -s -b jar.txt -H 'content-type: application/json' \
  -d '{"hostname":"*.example.com","note":"Client site"}' $BASE/api/v1/allowed-domains

# 3. Create an API key for n8n or CI. The raw key is shown once, so copy it now.
curl -s -b jar.txt -H 'content-type: application/json' \
  -d '{"name":"n8n production","scopes":["scans:read","scans:write"]}' $BASE/api/v1/api-keys
KEY=bcn_...   # the "key" field from the response

# 4. Start a scan. Repeating the Idempotency-Key returns the same scan.
curl -s -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'idempotency-key: monday-item-1234567890' \
  -d '{"url":"https://www.example.com","metadata":{"mondayItemId":"1234567890"}}' $BASE/api/v1/scans
# 202 {"id":"scn_...","status":"queued","statusUrl":"...","reportUrl":"..."}

# 5. Poll status and progress
curl -s -H "authorization: Bearer $KEY" $BASE/api/v1/scans/scn_...

# 6. Read findings. groupBy=fingerprint collapses identical issues across pages.
curl -s -H "authorization: Bearer $KEY" "$BASE/api/v1/scans/scn_.../issues?severity=critical&groupBy=fingerprint"

# 7. Cancel
curl -s -X POST -H "authorization: Bearer $KEY" $BASE/api/v1/scans/scn_.../cancel
```

Errors always have the shape `{ "error": { "code", "message", "details"? } }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `validation_error`, `bad_request` | Malformed body, query or cursor |
| 401 | `unauthorized` | Missing, invalid or revoked credentials |
| 403 | `forbidden` | Missing scope (for example `forms:submit`), or an admin-only route |
| 404 | `not_found` | Unknown scan, issue or route |
| 409 | `conflict` | The hostname already has a queued or running scan. `details.scan` holds it. |
| 422 | `domain_not_allowed`, `url_blocked` | Host not on the allowed list, or it resolves to a private address |
| 429 | `rate_limited` | Over the per-key limit. See the `Retry-After` header. |

Every response carries an `X-Request-Id` header.

## How a scan runs

1. **Discovery.** Status `discovering`. Reads `robots.txt` and `sitemap.xml` (following indexes) and crawls from the homepage, up to `MAX_PAGES`. The page total is fixed when discovery ends.
2. **Pages.** Status `running`. `PAGE_CONCURRENCY` pages at a time in Chromium. Each page is loaded, scrolled to the bottom to trigger lazy loading, then every enabled check runs. Findings are written as they are found, with a screenshot for each critical one.
3. **Links.** Every unique link on the site is verified once (HEAD, then GET if the server refuses HEAD). A broken link becomes one finding per page that contains it.
4. **Finalise.** Health score and per-check results, then `completed`.

Cancelling a scan stops queued work and closes the browser within a page or two. At most `MAX_CONCURRENT_SCANS` scans run at once and the rest wait as `queued`. Each scan sends at most `SCAN_RATE_LIMIT_RPS` requests a second to the site and backs off on 429 and 503.

| Check | Finds |
| --- | --- |
| `images` | Broken images (including lazy-loaded ones), broken `srcset` candidates and CSS backgrounds, missing `alt` |
| `links` | Broken internal and external links, redirect chains of three or more hops |
| `staging-urls` | Links, images, scripts, styles, canonicals and requests pointing at staging or development hosts |
| `page-health` | Non-2xx pages, JavaScript errors, failed requests, mixed content |

Screenshots are served at `GET /api/v1/scans/:id/issues/:issueId/screenshot`.

## Decisions and plan

- [docs/PLAN.md](docs/PLAN.md): phases and design points
- [docs/DECISIONS.md](docs/DECISIONS.md): choices made where the spec was open
