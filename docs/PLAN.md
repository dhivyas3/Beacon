# Beacon implementation plan

Beacon validates live websites after launch. A scan is submitted through a versioned,
key-authenticated API, a worker discovers every page and runs checks in the background,
and a React dashboard shows live progress and the final report.

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
6. **Integrations and polish** - signed callbacks with retries + `WebhookDelivery`, SSE
   throttling, CSV + PDF export, previous-scan comparison (new / still open / fixed), ignore
   states, command palette, n8n workflows, docs, end-to-end test, accessibility and
   responsive pass.

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
