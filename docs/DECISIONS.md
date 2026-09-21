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

## 2026-09-20 Members and admins hold the same scopes

A signed-in user gets `scans:read`, `scans:write` and `forms:submit` whatever their role, because the dashboard has to be able to start every kind of scan. The role only decides access to management routes (API keys, allowed domains, settings changes), which require an admin session. API keys can never call those routes, even with every scope.

## 2026-09-20 Idempotent replays answer 202 with the original scan

A repeated `Idempotency-Key` returns the same 202 body as the first call plus an `Idempotent-Replayed: true` header. The key is checked before the duplicate-scan rule, so a retry that arrives while the scan is running gets the original scan instead of a 409. Keys are stored as `actorKind:actorId:key` so two callers can reuse the same string.

## 2026-09-20 Callback URLs must be public too

Callback URLs go through the same SSRF check as scan targets and are not subject to the allowed-domains list. A callback receiver on a private network (for example n8n on a Docker network) is therefore refused. The supported setups are a public n8n URL or a reverse proxy in front of it. This is the safe default, and a deliberate allow-list for callback hosts can be added later.

## 2026-09-20 CSRF: SameSite=Lax plus an Origin check

Session cookies are `SameSite=Lax` and `HttpOnly`. On top of that, any state-changing request authenticated by a cookie is refused when its `Origin` header names a different host than `PUBLIC_URL` or the request host. Requests without an `Origin` header (curl, servers) pass, and API-key requests are not affected because they carry no ambient credential.

## 2026-09-20 Rate limiting

Limits are per API key or signed-in user, and per IP when anonymous, counted in Redis so several API replicas share them. The default is 120 requests a minute, set by `RATE_LIMIT_PER_MINUTE`. Sign-in is limited to 10 attempts a minute per IP. Health probes are exempt.

## 2026-09-20 Ignoring an issue recomputes a completed scan

Marking an issue ignored on a completed scan recounts open critical and warning issues, the page counters and the health score, so the report shows only what still needs attention. Running scans are not touched because the worker counts open issues when it finalises.

## 2026-09-20 Pagination cursors

List endpoints use opaque cursors (base64url of the last row id) with a stable sort. The grouped issues view groups in SQL, so its cursor encodes an offset. Any cursor that is not valid returns 400.

## 2026-09-20 Settings precedence

Values saved through `PATCH /settings` override environment defaults. A default form mode of `submit` is downgraded to `detect` for a caller that lacks the `forms:submit` scope, so a shared default can never be used to bypass the scope. An explicit `formMode: "submit"` without the scope is a 403.

## 2026-09-20 Deferred to later phases

The issue screenshot endpoint arrives with the storage package in Phase 3, when screenshots first exist. The `scan.cancelled` callback is sent from the cancel route in Phase 6 together with the other callbacks.

## 2026-09-20 Discovery: sitemap plus HTTP crawl, robots.txt informs but does not block

Pages come from `sitemap.xml` (following sitemap indexes to three levels and 50 files) and from a breadth-first crawl of every discovered page, all on the start URL's origin after redirects. The crawl reads raw HTML, so links that only exist after JavaScript runs are not found. Pages are never added after discovery, which keeps the page total fixed and progress monotonic. `robots.txt` is read for sitemap locations and a blanket `Disallow: /`, but its rules are not enforced: a scan is run by the site's owner, and the allowed domains list is the authorisation. URLs with more than three query parameters are skipped so faceted navigation cannot explode the page count, and `MAX_PAGES` caps the rest.

## 2026-09-20 The redirect target of the start URL must also be allowed

`http://example.com` may redirect to `https://www.example.com`. The scan continues on the final origin, but only if that hostname is also on the allowed list. Otherwise it fails with a message that names the host.

## 2026-09-20 Pages that redirect elsewhere are not checked twice

A page such as `/old-page` that redirects to `/about` is recorded and counted, but its checks are skipped, because they would only repeat the findings of the page it points at. The redirect itself is judged by the link check (three or more hops is a warning).

## 2026-09-20 Severity choices

- Broken image, broken `srcset` candidate, broken CSS background, staging URL, missing script or stylesheet, and a page that returns 4xx/5xx or will not load: critical.
- Missing alt text, console errors, uncaught exceptions, other failed requests, redirect chains of three or more hops, pages missing from the sitemap: warning.
- Passive mixed content (images over HTTP) is a warning, active mixed content is critical.
- A request the SSRF guard blocked inside the browser is info.
- On external sites, 401, 403, 429 and 999 are warnings ("could not be verified") because sites routinely refuse bots. Internal links get no such leniency.

## 2026-09-20 Link verification

HEAD first, GET when the server answers 403, 405 or 501. A GET reads only the first bytes. 429 and 503 trigger up to three retries that honour `Retry-After` (capped at 15 seconds) and slow the scan's request rate for 30 seconds. One retry for timeouts and refused connections. External hosts are throttled per host and use a lower concurrency. Internal links are always requested rather than trusting the page crawl, because the crawl follows redirects and would hide redirect chains.

## 2026-09-20 The browser is guarded, but cannot pin DNS

Every request Chromium makes, including subresources and redirects, goes through a route handler that resolves the host and refuses private, loopback, link-local and metadata addresses. Decisions are cached per origin. Chromium does its own DNS, so unlike the HTTP client it cannot be pinned to the validated address: a hostname that changes its DNS answer between the check and the connection could reach a private address. Run the worker on a network that cannot reach internal services for defence in depth.

## 2026-09-20 Screenshots

A critical issue found while a page is loaded gets a PNG with the element outlined in red, at most five per page. Critical issues without an element share one plain screenshot of the page. Warnings, and everything reported after the pages are closed (broken links), have none.

## 2026-09-20 Fingerprints and grouping

`fingerprint = sha256(checkType, rule, subject)` truncated to 16 hex characters. The subject is the resource URL by default (a broken image, link or staging URL), a normalised message for console errors, and empty for page-level rules. The same problem on the same page is stored once.

## 2026-09-20 Check results

`pagesChecked` is the number of pages processed. `issuesFound` counts open critical and warning issues of that check. A result is written for every check that ran, and also for any check type that reported findings from discovery, so `seo` appears once it reports a missing sitemap even before the full SEO check exists (Phase 5). Checks in the request that are not implemented yet (`forms`, `seo`) are skipped and logged.

## 2026-09-20 Worker shutdown fails running scans

On SIGTERM the worker aborts every running scan and marks it failed with "The worker restarted while this scan was running. Start it again." A scan whose worker is killed outright is failed by the reaper after two minutes. BullMQ does not retry stalled scan jobs.

## 2026-09-20 Tolerant link extraction instead of an HTML parser

Discovery pulls `<a href>` values with a regular expression after removing scripts, styles and comments. Strict parsers dropped a link nested inside an unclosed anchor, which real sites contain.

## 2026-09-20 Identifiable user agent everywhere

All HTTP requests send `QAHubBot/1.0 (website QA scan)`. Chromium keeps its normal user agent string and appends `QAHubBot/1.0`, so sites that sniff for browser features still work.

## 2026-09-20 Web: polling now, server-sent events later

The dashboard follows active scans with TanStack Query polling (1s for an open scan, 2s for the list, 15s when nothing is running, paused when the tab is hidden). It is simple, works through any proxy and survives reconnects for free. The SSE endpoint and client arrive in Phase 6, where the same query keys are updated from events, so components do not change.

## 2026-09-20 Web: checks that are not built yet are visible but disabled

`forms` and `seo` appear in the new-scan form and in scan defaults, greyed out and labelled "Runs when available", because the API already accepts them and hiding them would make Phase 5 look like a surprise. They are excluded from what the form submits.

## 2026-09-20 Web: the webhook secret is revealed on request

The secret comes from an environment variable, so it cannot be changed in the UI. `GET /settings/webhook-secret` (admin session only, `Cache-Control: no-store`) returns it so an admin can copy it into n8n. Settings shows a masked preview by default and fetches the secret only when the admin presses Reveal. API keys are the opposite: only a hash is stored, so a key is shown once at creation.

## 2026-09-20 Web: members see settings read-only

Members can see scan defaults but not keys, domains or webhooks. The tabs are hidden and an explanation is shown, rather than presenting screens that answer 403.

## 2026-09-20 Web: development proxy keeps the browser's Host header

Vite proxies `/api` with `changeOrigin: false` and targets `127.0.0.1`, not `localhost`. The API checks the `Origin` of state-changing requests against the request host, so rewriting Host would break sign-in. On Windows `localhost` can resolve to `::1` while the API listens on IPv4. In production, `deploy/nginx.conf` forwards `Host` as received for the same reason.

## 2026-09-20 Web: a 401 re-checks the session instead of clearing it

Any 401 invalidates the session query. If the session really ended, `/auth/me` answers 401 and the route guard redirects to sign in with a `next` parameter. Clearing the cache directly detached the observer and left people on a broken page.

## 2026-09-20 Web: ignoring an issue is optimistic and keeps the report honest

The row updates immediately and rolls back with a toast if the request fails. The API recomputes the scan's open counts, the page's counts, the per-check totals and the health score for completed scans, so the summary cards and check chips match what is listed. An undo action is offered in the confirmation toast.

## 2026-09-20 Web: report filters live in the API, not the browser

The report is paged, so filtering in the browser would only filter what has loaded. `checkType`, `severity`, `fingerprint` and `sort` are query parameters on the pages and issues endpoints, and each filter change is a new cursor-paginated query.

## 2026-09-20 Web: deferred to Phase 6

Export buttons (CSV and PDF), the command palette and the "fixed since last scan" list are not in the UI yet because their endpoints arrive in Phase 6. The "evidence drawer" is an expanding row plus a screenshot lightbox, which works at every width without a second panel.

## 2026-09-20 Web: report and settings load on demand

The report page carries the charting library, so it and settings are lazy-loaded. Sign-in and the dashboard stay in the main bundle, which dropped from about 1 MB to 566 kB (178 kB gzipped).

## 2026-09-21 Forms: three modes with a hard line between "blocked" and "sent"

`detect` reads the markup and never interacts. `validate_only` interacts, but inside a scratch copy of the page where every request that is not GET, HEAD or OPTIONS is recorded and then refused, so a bug in the check cannot become a real submission. `submit` is the only mode that lets a write through. The scope check stays in the API (`forms:submit`, enforced when the scan is created and when a default of `submit` is applied), because the worker has no notion of who asked. Tests assert both directions: the fixture site received nothing in the first two modes, and exactly one identified request per distinct form in the third.

## 2026-09-21 Forms: what is never touched

Forms with a CAPTCHA, a password field, a file input, payment-looking fields (`cc-*` autocomplete, card, cvv, iban), a destructive or financial button (delete, unsubscribe, buy, pay, checkout, donate), an action on another origin, or that are search boxes are skipped. Skips other than search, missing button and no fields are reported as `info` so nothing is silently untested. This is deliberately conservative: a false skip costs one manual check, a false submit could cost an order or a deleted account.

## 2026-09-21 Forms: each distinct form once per scan, at most 20

A newsletter box in every footer would otherwise be submitted once per page. A form's identity is its action (or "self" when it has none), method, field names and button text. State is kept in a `WeakMap` keyed by the scan, and a scan tests at most 20 forms. Findings attach to the first page where the form was seen and group across pages by fingerprint.

## 2026-09-21 Forms: test data and traceability

Test data is obviously artificial ("QA Hub Test", the configured test email, "This is an automated test from QA Hub. Please ignore it."). Only required fields, email fields and name or message fields are filled. Submissions carry `X-QAHub-Test: form-submission`, added only to writes to the site's own origin and the form's action origin so third-party scripts are not disturbed. The header is the supported way for a site owner to filter or reject test traffic.

## 2026-09-21 Forms: severity

A submission that fails on the server (5xx) or on the network is critical, because visitors cannot use the form. A 4xx is a warning: the server may be rejecting automation or our test data. Sent-but-no-confirmation, an error message shown after a 200, a button that sends nothing, empty or bad-email submissions being accepted, and a missing submit button are warnings. An insecure `http://` action on an https page, or a password field on an http page, is critical. Skips and "could not fill every required field" are `info`, which never counts towards the health score.

## 2026-09-21 Check-supplied screenshots

The main page cannot show what a form said after it was submitted, so an `IssueDraft` may carry `screenshotPng`. `PageScreenshots` stores it as the issue's screenshot in preference to highlighting an element, and it is never written into the evidence.

## 2026-09-21 SEO: what is flagged and how hard

Critical: no title, and `noindex` (an accidental noindex after launch is the classic disaster). Warnings: title over 70 characters, several title tags, no or absurdly long (over 320) description, no canonical, several canonicals, a canonical on a different non-staging site, no h1, no `lang`, missing `og:title`, `og:description` or `og:image`, a share image that does not load, and titles or descriptions shared by several pages. Short titles are not flagged because "Contact" is a legitimate title and the rule was noise. Several h1 elements are legal HTML5 and not flagged. A canonical on a staging host is left to the staging URLs check so it is not reported twice. Pages that did not answer 2xx are skipped, since the page health check already reports them. Sitemap findings still come from discovery.

## 2026-09-21 The browser session settles when a scan is stopped

A cancelled or shut-down scan could wait forever for a Playwright call that was in flight when its context was closed (seen as a hung test on the second page). Every call in `BrowserSession.load` now races the abort signal through `abortable`, and a navigation that fails because the scan is stopping is rethrown instead of being recorded as a page that failed to load.
