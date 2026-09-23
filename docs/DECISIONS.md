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
`@beacon/shared`. Prefixes: `usr`, `ses`, `key`, `dom`, `scn`, `pg`, `iss`, `chk`, `whd`.

## 2026-09-20 Local development without Docker

The bootstrap machine has no Docker. `@beacon/testkit` and `pnpm dev:services` start an
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

All HTTP requests send `BeaconBot/1.0 (website health monitor)`. Chromium keeps its normal user agent string and appends `BeaconBot/1.0`, so sites that sniff for browser features still work.

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

Test data is obviously artificial ("Beacon Test", the configured test email, "This is an automated test from Beacon. Please ignore it."). Only required fields, email fields and name or message fields are filled. Submissions carry `X-Beacon-Test: form-submission`, added only to writes to the site's own origin and the form's action origin so third-party scripts are not disturbed. The header is the supported way for a site owner to filter or reject test traffic.

## 2026-09-21 Forms: severity

A submission that fails on the server (5xx) or on the network is critical, because visitors cannot use the form. A 4xx is a warning: the server may be rejecting automation or our test data. Sent-but-no-confirmation, an error message shown after a 200, a button that sends nothing, empty or bad-email submissions being accepted, and a missing submit button are warnings. An insecure `http://` action on an https page, or a password field on an http page, is critical. Skips and "could not fill every required field" are `info`, which never counts towards the health score.

## 2026-09-21 Check-supplied screenshots

The main page cannot show what a form said after it was submitted, so an `IssueDraft` may carry `screenshotPng`. `PageScreenshots` stores it as the issue's screenshot in preference to highlighting an element, and it is never written into the evidence.

## 2026-09-21 SEO: what is flagged and how hard

Critical: no title, and `noindex` (an accidental noindex after launch is the classic disaster). Warnings: title over 70 characters, several title tags, no or absurdly long (over 320) description, no canonical, several canonicals, a canonical on a different non-staging site, no h1, no `lang`, missing `og:title`, `og:description` or `og:image`, a share image that does not load, and titles or descriptions shared by several pages. Short titles are not flagged because "Contact" is a legitimate title and the rule was noise. Several h1 elements are legal HTML5 and not flagged. A canonical on a staging host is left to the staging URLs check so it is not reported twice. Pages that did not answer 2xx are skipped, since the page health check already reports them. Sitemap findings still come from discovery.

## 2026-09-21 The browser session settles when a scan is stopped

A cancelled or shut-down scan could wait forever for a Playwright call that was in flight when its context was closed (seen as a hung test on the second page). Every call in `BrowserSession.load` now races the abort signal through `abortable`, and a navigation that fails because the scan is stopping is rethrown instead of being recorded as a page that failed to load.

## 2026-09-21 Rename: QA Hub becomes Beacon

Packages are `@beacon/*`, the bot is `BeaconBot/1.0`, callbacks will be signed with `X-Beacon-Signature`, form submissions carry `X-Beacon-Test`, the session cookie is `beacon_session` (so everyone is signed out once), and new API keys start with `bcn_`. Keys created before the rename start with `qah_` and are still accepted, because keys are looked up by hash and there is no reason to break a working integration. Callbacks were not delivered yet, so renaming their signature header breaks nobody. The working folder is still called "QA Hub" on this machine, because renaming the directory the tooling is running in gains nothing. Fixture data, test hostnames and the `qa.test` public URL used in tests are left alone.

## 2026-09-21 A check is a scan

The brief allows keeping `Scan` as the internal name to avoid a destructive migration. It is kept. "Check" is the word in the dashboard and in email. The API, the database and the code say scan, and `Website` is the new first-class concept a scan can belong to.

## 2026-09-21 One website per hostname

`Website.hostname` is unique. A hostname's history, its run numbers, the one-active-scan rule and the "previous check" all key on the hostname, so two websites on one hostname would share all of them and confuse each other. Registering a second returns `409` naming the existing one. A website's URL can be edited but must stay on its hostname; monitoring another hostname means adding another website.

## 2026-09-21 Pinned pages: a column on the website, merged into the sample

Of the two options in the brief, pinned pages are a `pinnedPageUrls` list on `Website` rather than a table. They are always included in a `random_sample` check, on top of the homepage, and they count towards the sample size. They do not replace `staticPageUrls`, which is a different mode where exactly the listed pages are checked. Pinned pages that discovery did not find are still checked, since the owner asked for them. If the homepage and pinned pages are more than the sample size, all of them are checked: the size is a target for the random part, not a cap on what the owner insisted on. "Eight random pages, homepage always included" therefore means eight pages in total, one of which is the homepage.

## 2026-09-21 A sample prefers pages not checked yet

A purely random sample can repeat the same pages for months. Instead the random part fills first with pages this website has never been checked on, chosen at random, and only when those run out does it repeat pages, oldest check first. Every run is still a fresh sample, and the count of distinct pages ever checked (shown on the website) grows until the whole site has been seen. A test proves a 31-page site is fully covered in eight runs of five.

## 2026-09-21 Page selection is stored on the scan

The website's selection (mode, list, pinned pages, sample size) is copied onto the scan when it is created, alongside the checks and form mode that were already copied. A run is then reproducible and independent of later edits to the website, and a request can override any of it ("check this website, but with 3 pages"). A scan of no website defaults to `full`, so nothing that worked before changes.

## 2026-09-21 The scheduler runs in the worker and plans from now

A repeating BullMQ job on the maintenance queue, shared by every worker, ticks every two minutes. Each due website is claimed with a compare-and-set on `nextCheckAt`, so simultaneous workers start it once, which a test proves with three concurrent ticks. `nextCheckAt` moves to the next scheduled time when the check is started, not when it completes as the brief suggests, because a claim that only moves on completion would let a second tick start the same check while the first runs. The next time is computed from now rather than from the missed time, so downtime produces one check and then the normal cadence, never a backlog. The catch-up on start is the same tick, run once at startup. If the previous check is still running, the website is retried half an hour later and the reason is shown.

## 2026-09-21 Scan creation lives in the db package

The API and the scheduler both create scans, and both must number runs per hostname and refuse a second active scan. That transaction is now `createQueuedScan` in `@beacon/db`, and the API calls it too. The scheduler skips the DNS check the API does on request, because the runner applies the same SSRF guard when it fetches the site and reports a clear failure.

## 2026-09-21 What "previous check" means

A completed scan records `previousScanId` when it finishes. It is the latest earlier completed scan of the same website, or of no website for a one-off scan, so a full audit is never compared with a sample of a few pages. Before completion, and for older rows, the same rule is computed on the fly. Migrated scans were backfilled per hostname. For a sampled check, "fixed since last check" only counts issues on pages that were checked both times, because an issue on a page that was not looked at again is unseen, not fixed. The same caveat applies in reverse: an issue on a page checked for the first time is labelled new even if it is old.

## 2026-09-21 Who owns a website, and who may change one

The owner is the signed-in user who created it, or, for an API key, the user who created the key. Ownership is informational for now: anyone with `scans:read` sees every website and `scans:write` changes them, as with scans. Saving a website with `formMode: "submit"` needs `forms:submit`, and that authorises its scheduled runs, which have no caller of their own. A manual check runs the website's own form mode without asking the caller again, since the configuration was already authorised.

## 2026-09-21 Website defaults

Weekly on Monday at 06:00 UTC, a random sample of ten pages, every check, forms in `validate_only` (safer than the `detect` default of a one-off scan, and it needs no scope), active. Times are stored and scheduled in UTC and are shown in the viewer's local time in the dashboard.

## 2026-09-21 Deleting and pausing

Deleting a website removes it and its recipients. Its past checks are kept as scans that belong to no website, so history and links keep working. A paused website is not scheduled but can still be checked manually.

## 2026-09-21 Failed checks show on the website

A check that finishes updates the website's `lastCheckAt`. A check that fails also leaves its message in `lastRunError` ("Could not reach ..."), which the next completed check clears, so an unreachable site is visible without opening the scan.

## 2026-09-21 Gap: callbacks are still to be built

The brief says n8n and monday.com "receive the completed callback exactly as before". Scans accept a `callbackUrl` and store it, but nothing sends the callback yet, because that was part of the original phase 6. It moves to phase 7, next to the email report, since both are sent from the same "scan finished" hook.

## 2026-09-22 One "scan finished" announcement drives callbacks and emails

Anything that ends a scan, whether the runner, the reaper failing a dead scan or the API cancelling one, announces it on a `notifications` queue with the job id `finished-<scanId>`, so a scan announced from two places is handled once. That job works out what the scan owes and writes a row for each thing: one `WebhookDelivery` per scan and event, one `EmailDelivery` per scan and recipient, both unique in the database. Only rows created by that run are queued, so running the job twice sends nothing twice. Each delivery is then its own job on the `callbacks` or `emails` queue, retried by BullMQ. The rows are the record: if Redis loses a job the row still says `pending`.

## 2026-09-22 Retries: what is worth another go

A callback or an email is tried up to six times, waiting 30 seconds, 2 minutes, 10 minutes, 1 hour and 6 hours between attempts. Timeouts, network errors, `5xx`, `408`, `425` and `429` are retried. Other `4xx` answers, a redirect and a refused address are final, since the same request would get the same answer: n8n answers `404` for a workflow that is not listening, and retrying that for six hours helps nobody. Email is classified the same way: Resend `429`/`5xx` and SMTP `4xx` are transient, other Resend `4xx` and SMTP `5xx` are permanent. A callback is never sent to a redirect target, because that would send the body somewhere nobody chose.

## 2026-09-22 The callback signature covers the raw body only

`X-Beacon-Signature: sha256=<HMAC-SHA256 of the raw body>`, keyed with the webhook secret, as the settings screen already told people. There is no signed timestamp: replay protection is the stable `X-Beacon-Delivery` id in the header and `deliveryId` in the body, which a receiver can remember. The payload has a `sentAt` that changes per attempt, so retries are not byte-identical. Signing uses Web Crypto so the shared package still bundles for the browser.

## 2026-09-22 Failed checks are emailed too

The brief asks for an email on every completed check. A site that is down at its monthly check would then never tell its owner, which defeats the point of monitoring, so a failed check sends a short failure notice with the reason and the last score that did complete, ignoring a recipient's "only new issues" preference. A failure that was only the worker restarting is not emailed, since it says nothing about the site. Callbacks still fire for it.

## 2026-09-22 What the email counts

The score tiles show the scan's critical and warning counts, the same numbers as the dashboard. The lists and the words ("3 new critical issues") count distinct problems: a broken link in every footer is one problem "and 199 other pages", not two hundred rows. A problem is new when the previous check of the website did not have it. On a first check nothing is new, because there is nothing to be new compared with. Because a sampled check looks at different pages each time, an old problem on a page seen for the first time is labelled new. That is what "new to Beacon" means, and it is stated in the email only as "new since the last check".

## 2026-09-22 A recipient chooses what they get, without a login

Each recipient can have every report, or only reports with something new or a lower score, or none. The link in the email holds the recipient's id and an HMAC of it under a key derived from the webhook secret, so it can act for that person only and cannot be edited to act for another. A GET only ever shows a page, because mail security scanners open every link in a message and would otherwise unsubscribe everyone. Changing a preference is a POST from the page's own form. The one-click address in the `List-Unsubscribe` header (RFC 8058) is a POST too. The pages are plain HTML with no script and a strict content security policy, and they are not in the OpenAPI document. The schedule is the owner's to change, so recipients cannot adjust the frequency, only what they receive.

## 2026-09-22 The email is MJML, and the chart is table cells

MJML 5 (which compiles asynchronously) turns the layout into inlined tables that Outlook and Gmail accept, and the build fails on invalid markup, so the tests catch a broken template. The trend chart is a row of coloured table cells rather than an SVG or a PNG: Gmail and Outlook strip SVG and data-URI images, and remote images are blocked by default in many clients, so any image would show as a broken box for many people. Older bars are grey and the latest is in its score colour, scaled to the recent range so a fall is visible. The score ring is a bordered rounded cell, which is square in clients that ignore `border-radius`. The font stack starts with Inter and falls back to system fonts, without Roboto, because MJML answers a named web font by linking Google Fonts. The email opts out of forced dark mode (`color-scheme: light only`) so the palette is what people see; a dark variant is deferred.

## 2026-09-22 What was and was not checked in real mail clients

Litmus and real Gmail, Outlook and Apple Mail were not available in this environment, so rendering there has not been checked. What was checked: every variant rendered in Chromium at desktop and phone widths and reviewed by eye, strict MJML validation, tests that every email is under Gmail's 102 KB clipping limit, uses tables and inline styles, and contains no script, image, remote stylesheet or font, and that hostile text from a scanned site is escaped. Before relying on it, send the preview to a Gmail, an Outlook and an Apple Mail account (the outbox files can be attached to a test message) and check the score ring, the tiles and the button.

## 2026-09-22 Providers: Resend by default, SMTP for anything else, an outbox for development

Behind one `EmailSender` interface. Resend is used when `RESEND_API_KEY` is set. `smtp` (nodemailer) covers any relay, including Postmark and SES. With nothing configured the `log` provider writes each email to `data/outbox` as HTML, text and JSON, so development works with no account and no risk of mailing anyone. A provider that is chosen but missing its setting gives a sender that fails every attempt with that reason, so it shows on the website instead of vanishing. Blank values in `.env` and in compose count as unset.

## 2026-09-22 The embedded Postgres is created as UTF-8

On Windows the embedded server took its encoding from the system code page (WIN1252), which cannot store an emoji, so saving the subject of an email failed, and any non-Latin text in a scanned page's findings would have failed the same way. Production Postgres is UTF-8. The embedded server is now initialised with `--encoding=UTF8 --locale=C`. A data directory created earlier keeps its old encoding and must be deleted (`data/`) and recreated.

## 2026-09-22 Cancelling announces itself

Cancelling happens in the API, which has no way to send a callback, so it puts the same `finished-<scanId>` announcement on the notifications queue. It is best effort: a cancellation that already happened is never undone because Redis was busy.

## 2026-09-23 The live event stream reads the database once a second

`GET /scans/:id/events` is a server-sent event stream. The worker and the API are separate processes with no shared channel for progress, and the scan row is already the source of truth, so the stream looks at the row once a second and sends what changed, the same numbers polling would have fetched. That keeps it simple and correct after any restart, at the price of one small query pair a second per open report. It sends `progress` when progress or the summary changes, `issue` for issues found after the connection opened (the page loads earlier ones itself, so nothing is replayed), and `done` with the final state, then closes. A comment line every 15 seconds keeps proxies from timing it out, and a stream ends after an hour so nothing lives forever: the browser reconnects and is told the current state straight away. Not-found and authentication failures are answered as ordinary JSON before the connection becomes a stream, because an error envelope cannot be sent once it has started. The route hijacks the reply, so it skips the response schema; the OpenAPI entry says what the events are.

## 2026-09-23 Only the open report streams; cards and lists poll

Browsers allow about six HTTP/1.1 connections to one origin. An overview with a handful of live checks, each holding a stream, would use them all and freeze the app. So one stream is opened for the report that is on screen, and website cards, the website page and lists keep polling every one to two seconds while something runs (and not at all when idle, as before). While a stream is connected the report's own polling slows to every ten seconds as a safety net. If the stream cannot open or drops, polling goes back to every second, so a proxy that buffers or blocks event streams costs latency and nothing else. `EventSource` reconnects by itself, and the hook only records whether it is connected.

## 2026-09-23 The overview is the home page, and scans moved to /scans

The overview of websites is what most people came for now, so it is `/`, and the table of every scan (with the box to start a one-off scan) is `/scans`. Report links are `/scans/:id` and stay as they are, because they are already in sent emails and callbacks. Websites are `/websites`, `/websites/new`, `/websites/:id` and `/websites/:id/edit`. The overview puts what needs attention first (poor score, then fair, then good, with never-checked and paused last) rather than alphabetically, so the site that is in trouble is the first card. "Needs attention" means a poor score or any critical issue in the latest check.

## 2026-09-23 The website form

The schedule is entered in UTC, which is how it is stored and run, with the viewer's own time shown beside it ("06:00 UTC, which is 07:00 BST for you") and the next planned check in local time, so nobody has to do the sum. Pages to pin or list are one per line, and a path such as `/contact` is taken to be on the website itself. Recipients are entered on the add form and managed on the website page afterwards, where every change (add, pause, choose what they receive, remove) is saved at once, so there are not two places that edit the same list. `Submit test data` is shown to everyone but disabled without the `forms:submit` permission, with the reason, rather than hidden. Server refusals are put next to the field they are about: a domain that is not allowed or a hostname already registered under the address, and the per-field problems of a bad combination under their fields.

## 2026-09-23 Exports: the CSV has everything, the PDF is a summary

The CSV has one row per issue occurrence, open and ignored, most severe first, with a byte order mark so Excel reads it as UTF-8. A cell that would run as a spreadsheet formula (it starts with `=`, `+`, `-`, `@` or a tab) is prefixed with an apostrophe, because the messages and URLs come from scanned sites. The PDF is built on the server with pdfkit and lists the score, the counts and up to 100 open problems, one per issue however many pages it is on, each with up to three example pages. The built-in PDF fonts cover Latin-1 and common punctuation, so anything else, an emoji in a page title for instance, is printed as `?` rather than as garbage. Bundling a Unicode font would fix that at the cost of about half a megabyte and a licence to track; it can be added if a customer needs it.

## 2026-09-23 "Fixed since the last check" has one definition

The count on the report and the list under it come from the same query, so they cannot disagree: problems the previous check of the same website had that this scan does not have. For a scan of a sample only pages checked both times count, because a page that was not looked at again is unseen, not fixed, and the report says so.

## 2026-09-24 The end-to-end suite runs the real system on its own ports

`pnpm e2e` starts an embedded Postgres, a Redis, the fixture site, the API, the worker and the Vite dev server as child processes (`e2e/src/stack.ts`), on ports different from `pnpm dev`, so both can run at once, with its own database, queue prefix, storage and email outbox under `e2e/.tmp`. Nothing is mocked: the specs drive a browser through registering a website, checking it, reading the report, exporting it and finding the emails in the outbox, and call the API as n8n would, with a receiver that verifies the callback signature. `ALLOW_LOCAL_TARGETS` is on for that stack only, because the fixture site and the receiver are on loopback; the only site ever scanned is the fixture. The specs run in order in one worker (the first registers the website that the later ones use), so a failure in the first hides the rest, and the run takes about ninety seconds. It is not part of `pnpm test`, which stays fast and needs no browser.

## 2026-09-24 What the end-to-end run found

Two real bugs that 150 unit tests did not. The live-events hook wrote a scan's final `progress` event into the cache, which made the scan no longer active, which switched its own stream off before the `done` event arrived, so a report followed live finished with no per-check results until a manual refresh. It now loads the whole scan on a final progress event and stays connected until `done`. And a table wider than a phone, inside a scroller, still stretched the page, because its visually hidden text is absolutely positioned and escaped the scroller's clip: `.scroll-x` is now positioned. Lesson kept in CLAUDE.md: a fake `EventSource` in a unit test proves the handlers, not the sequence a real server produces.

## 2026-09-24 Accessibility: checked by a tool in both themes, and by hand for what a tool cannot see

axe-core (WCAG 2.0, 2.1 and 2.2 level A and AA) runs in the end-to-end suite over every screen in the light and dark themes, and over the open command palette, and fails on any violation. It found one: white text on the dark theme's accent colour was 4.47:1, so the dark accent is a shade deeper (`#5c5fee`, 4.85:1) and its hover state deeper still (5.57:1) rather than lighter, because the text has to keep its contrast. The suite also checks that nothing scrolls sideways at 390 px on any screen, that the first Tab stop is the skip link, and that every control that takes keyboard focus shows an outline. Not checked by a person with a screen reader: the event stream is announced only by the progress bar's own label, and the command palette follows the combobox and listbox pattern (`aria-activedescendant`) but has not been used with NVDA, JAWS or VoiceOver.

## 2026-09-24 The command palette is hand-written

Ctrl+K (Cmd+K on a Mac), or the Search button in the header, opens a dialog with a search box over a list of pages, actions, websites (open, or check now) and appearance and sign-out commands. It is a Radix dialog with a combobox and listbox written by hand, about 250 lines, instead of a dependency such as cmdk, so it follows the rest of the app's components and adds nothing to the bundle. Matching is pure and tested (`lib/commands.ts`): every word must match, the start of the label ranks first, then a word in it, then the hint and keywords, and ties keep their order so results do not shuffle as you type. Websites are only fetched once the palette is opened.

## 2026-09-24 The n8n workflows use core nodes and keep the secret in the Code node

Nothing to install: Schedule Trigger, Webhook, Set, Code, IF, Respond to Webhook and HTTP Request. monday.com is reached with its GraphQL API (`create_update`) rather than the monday.com node, whose parameter names are easy to get wrong in hand-written JSON. The callback workflow replies before it does any work (Beacon waits fifteen seconds and retries anything slower), answers `401` to a bad signature so Beacon does not retry it, and keeps the webhook secret in the Code node, because recent n8n versions block environment access from nodes by default and Variables are a paid feature. A test in `packages/shared` runs that Code node against signatures made by `callbackSignature` and checks the graph of every workflow. What is not checked: importing them into a running n8n. That was not available here.

## 2026-09-24 Deployment: Caddy in front of the web container, unverified

`deploy/Caddyfile` and `deploy/docker-compose.caddy.yml` put Caddy (automatic HTTPS) in front of the existing web container, which already proxies `/api` to the API, and stop publishing the web port. `flush_interval -1` keeps the event stream flowing. Docker was not available, so neither the base compose file nor this override has been run, as with the earlier phases; `docs/DEPLOYMENT.md` says so at the top. The pieces they start are the ones `pnpm e2e` runs.

## 2026-09-23 Deleting a scan

`DELETE /scans/:id` is a hard delete, not a soft one: there is no "trash" anywhere else in Beacon (deleting a website already hard-deletes the `Website` row, keeping its scans as one-off ones), so a second, different deletion model just for scans would be its own thing to explain. It needs `scans:write`, the same scope `cancel` already needs, rather than `admin`: an API key that can start and cancel checks can already make just as much of a mess, and splitting the two would mean giving out `admin` for what is otherwise an ordinary scan action.

A scan that is queued, discovering or running cannot be deleted (`409`, the same shape as a cancel of a finished scan): the worker is still writing pages and issues to it, and deleting the row out from under a live foreign key would either fail confusingly or, worse, half-succeed. Cancel it first, then delete it.

Nothing elsewhere breaks: `ScanPage`, `ScanIssue`, `CheckResult`, `WebhookDelivery` and `EmailDelivery` all cascade with the scan, and a later scan's `previousScanId` is set null rather than the delete being refused (already how the schema was written), so it just stops being compared against something that no longer exists. A website's `latest`, history and page counts are computed live from whatever scans remain, so deleting one is not a special case there either. The one thing not in Postgres is screenshots, which live on disk: `ScanService.delete` best-effort removes `storage.deletePrefix(screenshotPrefix(id))` after the row is gone, so a delete that could not reach the screenshots because of some ephemeral IO wobble does not also fail to remove the record.

Run numbers are not renumbered after a delete (`@@unique([hostname, runNumber])` on what is left), so a hostname can show runs #1, #4, #7 with gaps in between. That is the honest history rather than a claim that nothing was ever removed.
