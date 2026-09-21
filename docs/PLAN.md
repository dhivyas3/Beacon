# Beacon implementation plan

Beacon keeps watch on the health of websites. A registered **Website** is checked on a
schedule (daily, weekly, monthly), usually on a handful of representative pages, and the
report is emailed to whoever owns the site. One-off full scans, started from the dashboard, the
API, n8n or monday.com, remain and are one trigger type among several. A key-authenticated
API, a worker that runs the checks in the background and a React dashboard sit underneath.
See [SPEC.md](SPEC.md) for the product.

## Repository layout

```
apps/api          Fastify 5 public API (+ OpenAPI 3.1 at /api/docs), sessions, API keys, SSE
apps/worker       BullMQ consumers: discovery, page checks, link verification, callbacks
apps/web          React 19 + Vite dashboard (Tailwind 4, shadcn-style components, TanStack Query)
packages/shared   Zod schemas + types (the API contract), progress maths, health score, URL utils
packages/db       Prisma schema, migrations, client factory, seed script
packages/net      SSRF-safe HTTP client (DNS pinning, private range rejection, redirect re-checks)
packages/storage  Storage interface + local-disk implementation (screenshots, PDFs)
packages/testkit  Test helpers: embedded Postgres, Redis, migrations, fixture site boot
fixtures/site     Deterministic local site with known defects, served by a tiny Node server
e2e               Playwright Test suite (sign in, run a scan, read the report)
docs              PLAN, DECISIONS, INTEGRATIONS, DEPLOYMENT, n8n workflow JSON
```

## Build phases

Each phase ends with `pnpm typecheck && pnpm lint && pnpm test` green and a conventional commit.

1. **Foundation** - pnpm + Turborepo monorepo, TypeScript strict, ESLint/Prettier, Vitest,
   Docker Compose (postgres 16, redis 7, api, worker, web), Prisma schema + first migration,
   shared Zod contract, progress/health-score/URL utilities with unit tests, CI workflow,
   `CLAUDE.md`, `.env.example`.
2. **API core** - config validation, pino logging, request IDs, JSON error envelope, session
   auth (argon2 + httpOnly cookie), API-key auth with scopes and per-key rate limiting,
   allowed domains, scan create/list/get/pages/issues/cancel, idempotency, 409 duplicate
   guard, OpenAPI with examples, integration tests against a real Postgres.
3. **Scan engine** - BullMQ queues (`scan`, `page`, `links`, `callbacks`), discovery
   (robots, sitemap index, BFS crawl, URL normalisation, MAX_PAGES), Playwright browser pool,
   `Check` interface, `images` / `links` / `page-health` / `staging-urls` checks, per-page
   progress + heartbeat, stale-scan reaper, global concurrency cap, cancel, SSRF guards,
   fixture site, check tests.
4. **Web app** - design tokens, light/dark themes, sign in, dashboard (new scan, live table
   over SSE with polling fallback), scan detail (progress, live issue feed, cancel), report
   (summary cards, check chips, by-page / by-issue views, evidence drawer, screenshots),
   settings (API keys, domains, secret, defaults). Delivered with polling: SSE moves to phase 6
   with the other deferred items (see DECISIONS.md, "Web: deferred to Phase 6").
5. **Forms and SEO** - `forms` check with `detect` / `validate_only` / `submit` modes and
   `forms:submit` scope enforcement, `seo` check, screenshots with element highlighting.
   Delivered: forms are tested in a scratch page; the browser session and screenshots are as in
   phase 3, plus check-supplied screenshots (see DECISIONS.md, "Forms").
Phases 6 to 9 follow the pivot from a one-off launch scanner to scheduled monitoring
(the brief is in [SPEC.md](SPEC.md), section "Beacon"). The original phase 6 (callbacks,
SSE, exports, comparison, command palette, n8n docs, end-to-end test, accessibility) is split
across them, because the email report needs the comparison and the completion hook.

6. **Websites, scheduling and page selection** - rename to Beacon; `Website`,
   `WebsiteRecipient` and the scan extensions (`websiteId`, `triggeredByType`,
   `previousScanId`, page-selection columns) in one additive migration; `full`,
   `static_list` and `random_sample` selection in the runner; pure schedule maths; a
   scheduler tick (BullMQ repeatable job) with catch-up on start; `/websites` API including
   `check-now`, `history` and recipients; `websiteId` on `POST /scans`.
7. **Email reports and notifications** - `EmailSender` interface with Resend by default,
   `EmailDelivery` log with retries, the `packages/email-templates` package (MJML) with
   `pnpm email:preview`, subject and "all clear" variants, sparkline, "new since last
   check"; signed callbacks with retries + `WebhookDelivery` (n8n and monday.com), sent from
   the same completion hook; previous-scan comparison made website aware (new / still open /
   fixed). Delivered, with two additions: failed checks are emailed too, and recipients can choose
   what they receive and unsubscribe without a login (see DECISIONS.md, 'Phase 7' entries).
8. **Websites UI and dashboard overview** - Websites nav, list, add/edit form (schedule, page
   selection, checks, recipients, email toggle), detail page with score chart and history,
   check-now, report breadcrumb and trend badge, overview dashboard of website cards, SSE
   progress, CSV + PDF export, ignore states. Delivered (see DECISIONS.md, 'live event stream',
   'The overview is the home page', 'The website form' and 'Exports'). The report also lists
   what was fixed since the last check.
9. **Docs, n8n and polish** - `INTEGRATIONS.md` with n8n workflows (including the
   n8n-scheduled pattern), deployment guide with Caddy, command palette, end-to-end test,
   accessibility and responsive pass.

## Key design points

- **One contract.** Every request/response shape is a Zod schema in `@beacon/shared`.
  Fastify validates and serialises with them and emits the OpenAPI spec from them; the web
  client imports the inferred types.
- **Progress computed once.** `computeProgress()` in `@beacon/shared` turns a `Scan` row
  into the `progress` object. The API, the SSE stream and the dashboard all call it.
- **Counters live on `Scan`.** The worker updates aggregate counters (pages, links, issue
  counts, rolling averages) at most every 2 s, so the dashboard list is one cheap query.
- **Checks are plug-ins.** Each check is a module implementing `Check` (`id`, `label`,
  `run(context)`), registered in a single array in the worker.
- **Safety first.** All outbound requests (scan targets, link checks, callbacks) go through
  `@beacon/net`, which resolves DNS, rejects loopback / private / link-local / metadata
  ranges, re-checks on every redirect, and only allows `http(s)`.
- **Local dev without Docker.** `pnpm dev:services` boots an embedded Postgres and a Redis
  server so tests and development run on a laptop that cannot run Docker. Docker Compose
  remains the canonical way to run the whole system.
