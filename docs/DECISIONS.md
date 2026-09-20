# Decisions

Format: date, decision, why. Newest at the bottom.

## 2026-09-20 Pin known-stable majors rather than the newest releases

TypeScript 5.9 (not the 7.x rewrite), Prisma 6, Vite 7, ESLint 9, Vitest 3, BullMQ 5,
ioredis 5, undici 7, React Router 7, Zod 4. Newer majors exist for several of these but they
change tooling contracts (Prisma 7 driver adapters, TypeScript 7 toolchain) and are not yet
supported uniformly by the rest of the stack. Upgrading is a follow-up, not a prerequisite.

## 2026-09-20 Server-side sessions in a `Session` table

The spec asks for an httpOnly session cookie. Sessions are stored in Postgres (hashed
token, expiry) rather than as a signed stateless cookie so that sign-out and password
changes revoke access immediately and the API-key and session auth paths share one
`Actor` model.

## 2026-09-20 Idempotency keys are scoped to the actor

`Scan.idempotencyKey` stores `${actorId}:${Idempotency-Key}` and is unique. Two API keys
using the same header value never collide, which matches how Stripe scopes keys.

## 2026-09-20 `passedCount` = pages with no critical or warning issue

The spec lists `passedCount` on `Scan` without defining it. It is the number of pages that
finished with zero critical or warning issues. `CheckResult` rows separately prove which
checks ran and passed.

## 2026-09-20 Extra columns on `Scan` for progress maths

To compute `progress` in one place from a single row, the worker persists `pagesFound`
(during discovery), `linksTotal`, `linksChecked`, `stage` (`pages` | `links` | `finalising`),
`avgPageMs` and `avgLinkMs` (rolling averages of the last 20 durations), `pageConcurrency`,
`linkConcurrency`, `seedDurationMs` (duration of the previous completed scan for the
hostname) and `progressPercent` (last emitted value, for monotonicity).

## 2026-09-20 Per-hostname run numbers use a counter table

`HostnameCounter` is upserted inside the scan-creation transaction, giving gap-free
per-hostname run numbers without retry loops on a unique index.

## 2026-09-20 URL normalisation strips the trailing slash

`normalizeUrl` lowercases scheme and host, removes default ports, fragments and tracking
parameters (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `_ga`, `_gl`), sorts remaining
query parameters and strips a trailing slash from non-root paths. Servers that prefer a
trailing slash redirect and the crawler follows, so the page is still counted once.

## 2026-09-20 `*.example.com` also matches the apex

A wildcard allowed-domain entry matches every subdomain and the apex, so one entry covers
`example.com` and `www.example.com`. Exact entries match only that hostname.

## 2026-09-20 Prefixed IDs are generated in application code

Prisma cannot call a custom generator, so every `create` passes `id: newId('scn')` from
`@qa-hub/shared`. Prefixes: `usr`, `ses`, `key`, `dom`, `scn`, `pg`, `iss`, `chk`, `whd`.

## 2026-09-20 Local development without Docker

The bootstrap machine has no Docker. `@qa-hub/testkit` and `pnpm dev:services` start an
embedded Postgres and a `redis-server` binary when `DATABASE_URL` / `REDIS_URL` are not set.
Docker Compose remains the canonical way to run the product and CI uses service containers.
The embedded Postgres is version 16 to match production.

## 2026-09-20 ETA smoothing happens in the client

The server returns the raw ETA computed from the rolling averages. Exponential smoothing
needs per-viewer state, so the web app smooths (alpha 0.3) and rounds for display. The API
stays stateless and its numbers are reproducible.

## 2026-09-20 Settings table for editable defaults

Scan defaults (checks, form mode, form test email) are stored in a `Setting` key/value
table. The webhook signing secret stays in the environment (`WEBHOOK_SIGNING_SECRET`); the UI
shows it masked with a copy button.

## 2026-09-20 `@node-rs/argon2` instead of `argon2`

The spec asks for argon2 password hashing. The `argon2` npm package compiles a native addon at
install time and failed on the bootstrap machine (no C++ toolchain). `@node-rs/argon2` is the
same algorithm (argon2id) with prebuilt binaries for Windows, macOS, and Linux (glibc and musl),
so installs and Docker builds need no compiler.

## 2026-09-20 Pages run in-process; BullMQ carries scans and callbacks

One BullMQ job per scan (worker concurrency = `MAX_CONCURRENT_SCANS`, default 3) runs discovery,
the page pool, link verification and finalising. Page checks are not individual queue jobs:
they share one Playwright browser pool per scan, which is what makes rolling ETA and per-scan
rate limiting straightforward. Cancelling flips the scan row to `cancelled`; the running job
sees it on the next page boundary, drains the pool and closes its browsers. Webhook callbacks
use their own queue so retries with exponential backoff survive worker restarts. The stale-scan
reaper covers a worker that dies mid-scan.

## 2026-09-20 Errors: 400 for malformed input, 422 for rule violations

Schema validation failures return 400 `validation_error`. Well-formed requests that break a
business rule (host not on the allowed list, URL resolves to a private address) return 422.

## 2026-09-20 One active scan per hostname is enforced by a partial unique index

A partial unique index on `Scan(hostname)` where status is queued, discovering or running makes
the 409 duplicate guard race-free. Prisma cannot express partial indexes, so it is appended to
the initial migration by hand.

## 2026-09-20 Link verification uses `ScanLink` and `ScanLinkSource` tables

Global de-duplication of links needs a place to hold every unique URL and the pages that
reference it. A broken link then becomes one issue per referencing page, so "affects N pages"
grouping works the same as for every other check.
