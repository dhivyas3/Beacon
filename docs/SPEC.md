# Beacon product specification

Beacon keeps watch on the health of websites. A person registers a site once. Beacon then checks
it on a schedule, usually on a handful of representative pages, and emails a dashboard-style
report to whoever owns the site. Full one-off scans, started from the dashboard, the API, n8n or
monday.com, remain and are one way of triggering a check among several.

This document says what Beacon is and does. [PLAN.md](PLAN.md) says in what order it is built,
and [DECISIONS.md](DECISIONS.md) records the choices made along the way and why.

> Beacon began as "QA Hub", a one-off post-launch QA scanner (phases 1 to 5 of the plan). From
> phase 6 it is a recurring monitor, and everything the scanner did is still there.

## 1. Who uses it

- **A site owner or account manager** registers a website, chooses how often and how deeply it is
  checked, and reads the emailed report.
- **A developer or QA engineer** starts a full one-off scan after a launch, reads the report and
  ignores findings that are known and accepted.
- **An integration** (n8n, monday.com through n8n, CI) starts checks and receives a signed
  callback when they finish.
- **An admin** manages API keys, the list of hostnames that may be scanned, and defaults.

## 2. Concepts

| Concept | Meaning |
| --- | --- |
| **Website** | A site that is monitored: URL, schedule, page selection, enabled checks, form mode, recipients. One website per hostname. |
| **Check** | One execution against a website. Stored as a `Scan`, and called a check in the dashboard. |
| **Scan** | The internal model for any run. It belongs to a website, or to none for a one-off scan. |
| **Page selection** | Which pages a scan covers: `full`, `static_list` or `random_sample`. |
| **Trigger** | Where a scan came from: `manual_ui`, `manual_api`, `scheduled`, `n8n`, `monday`. |
| **Issue** | A finding on a page or on the site, with severity, evidence and often a screenshot. |
| **Health score** | 0 to 100, from how many critical issues and warnings there are per page checked. |
| **Recipient** | An email address that receives a website's report. |

## 3. What a scan does

1. **Selects pages** (section 5).
2. **Runs checks** on every selected page in a headless browser: images, links, staging URLs,
   forms, page health, SEO.
3. **Verifies every link once** across the whole page set, de-duplicated.
4. **Scores and stores** the result, links it to the previous scan, and notifies.

### Checks

| Check | Looks for |
| --- | --- |
| `images` | Broken images, missing `alt`, broken `srcset` candidates and CSS backgrounds |
| `links` | Broken, redirect-chained and unreachable links |
| `staging-urls` | Links, images, scripts, canonicals and requests that point at staging or development hosts |
| `page-health` | Non-2xx pages, console errors, uncaught exceptions, failing requests, mixed content |
| `seo` | Titles, descriptions, canonicals, `noindex`, h1, `lang`, social tags, share image, duplicates, sitemap |
| `forms` | By form mode: markup problems only (`detect`), validation without sending (`validate_only`), or a real submission with test data (`submit`) |

Severity is `critical` (visitors will hit it), `warning` (worth fixing) or `info` (context, never
counted).

### Health score

```
score = 100 - min(100, (critical * 5 + warnings) / pagesTotal * 10)
```

rounded to an integer. Open issues only: ignoring an issue removes it from the score.

### Progress and estimate

Progress is one weighted percentage that never moves backwards: 0 to 5 discovery, 5 to 85 pages,
85 to 98 links, 98 to 100 finishing. The estimate says "Estimating…" until ten pages are done,
then uses a rolling average, smoothed and rounded the way a person would say it.

## 4. Safety

- **Allowed domains.** Only hostnames on the admin's list can be scanned or registered.
- **SSRF protection.** Every outbound request, including the browser's, resolves DNS, refuses
  loopback, private, link-local and metadata addresses, and re-checks on every redirect.
- **Polite.** The bot identifies itself as `BeaconBot/1.0`, is rate limited, and backs off on
  429 and 503.
- **Forms.** Login, payment, upload, CAPTCHA, search, third-party and destructive-looking forms are
  never touched. In `validate_only` mode every request that could send data is blocked, so
  nothing reaches the server. `submit` needs the `forms:submit` scope.
- **Secrets.** API keys are stored hashed and shown once. Callbacks are signed with HMAC-SHA256.
- **Never scan third-party sites in development.** Use the fixture site.

## 5. Page selection

| Mode | Behaviour |
| --- | --- |
| `full` | Discover every page (sitemap first, crawl as a fallback) and check all of them. The behaviour of phases 1 to 5, and the default for a scan of no website. |
| `static_list` | Check exactly the listed URLs, which must be on the website's origin. No discovery. |
| `random_sample` | Discover every page, then check `sampleSize` of them. The homepage and any pinned pages are always included and count towards the size. The rest are chosen at random, preferring pages this website has never been checked on, so coverage grows check by check. |

Site-wide link verification runs across whatever pages were checked. "Pages ever checked" is the
number of distinct URLs across a website's completed checks, shown on its page.

A scan of a sample compares itself with the previous check of the same website. "Fixed since last
check" only counts issues on pages that were checked both times, because an issue on a page that
was not looked at again is unseen, not fixed.

## 6. Websites and scheduling

A website has a `checkFrequency`: `manual`, `daily`, `weekly` (a day of the week), or `monthly` (a
day of the month, clamped to the last day of shorter months), at an hour of the day in UTC.

- A scheduler tick runs every two minutes on every worker and starts a check for each active
  website whose `nextCheckAt` has passed. A compare-and-set claim means exactly one worker starts
  each.
- The next check is planned from now, never from the missed time. After downtime, a website is
  checked once and then follows its cadence, with no backlog. The same tick runs when a worker
  starts, which is the catch-up.
- If a check is still running when the next is due, it is tried again half an hour later.
- Pausing a website clears its next check. Resuming, or changing its schedule, plans it again from
  now. Editing anything else leaves the planned time alone.
- A check can be started at any time with `check-now`, from the dashboard or the API. It does not
  move the schedule.
- The reason a scheduled check could not start (a removed domain, a check still running) is kept
  on the website and shown in the dashboard.

## 7. The API

Versioned under `/api/v1`, authenticated by an API key (`Authorization: Bearer bcn_...`) or, for
the dashboard, a session cookie. OpenAPI 3.1 is served at `/api/docs`.

- **Scans:** create, list, get (with per-check results, previous scan and score change), cancel,
  issues (flat or grouped by fingerprint), ignore or reopen an issue, screenshots, pages, the
  problems fixed since the previous check, a live event stream (`/events`, server-sent), and CSV
  and PDF exports.
- **Websites:** create, list, get, update, delete, `check-now`, `history`, recipients.
- **Admin:** API keys, allowed domains, settings.
- **Conventions:** JSON error envelope `{ error: { code, message, details? } }`, cursor
  pagination, `Idempotency-Key` on scan creation, `409` when a hostname already has an active
  scan, per-key rate limits.
- **Triggers:** an API key may send `source: "n8n" | "monday"` so the dashboard shows where a
  check came from.

Signed callbacks (`X-Beacon-Signature: sha256=<hmac of the raw body>`) are sent to a scan's
`callbackUrl` when it completes, fails or is cancelled. They are retried up to six times over about
seven hours, with a stable delivery id so a receiver can ignore duplicates. See
[INTEGRATIONS.md](INTEGRATIONS.md).

## 8. Email reports

Sent on every completed check of a website that has at least one active recipient and email
enabled. Never sent for a scan of no website.

- **Provider:** a small `EmailSender` interface. Resend by default; Postmark, SES or SMTP are a
  configuration choice.
- **Template:** a designed HTML email, built with MJML so it survives Outlook and Gmail. Header
  with wordmark, website and date. A score card with a ring and three stat tiles. A trend line
  with delta and a chart of the last 12 scores, drawn from table cells because Gmail and Outlook
  strip SVG and images. New issues first, still open issues as a count, up to ten issues, with a
  problem that repeats across pages shown once. A prominent "View full report" button, links to
  manage preferences and to unsubscribe, and a footer.
- **All clear variant:** when there are no new issues and the score is stable or better, a calmer
  design with a green accent, recognisable from the subject line.
- **Subject:** generated, for example `✅ example-estates.co.uk — health score 94 (no new
  issues)` or `⚠️ example-estates.co.uk — health score 61 (3 new critical issues)`.
- **Preview:** `pnpm email:preview` renders the template against fixture data without sending.
- **Failed checks:** a check that could not run (a site that is down) sends a short failure
  notice, so silence never means a site is fine.
- **Recipients:** each chooses every report, only reports with new issues, or none, through a link
  in the email that needs no login. Emails carry `List-Unsubscribe` headers.
- **Reliability:** every send is logged in `EmailDelivery`; transient failures are retried;
  failures show on the website's page.

## 9. The dashboard

- **Overview:** the home page. One card per website with score, change since the last check
  and next check, live progress for checks that are running, and what needs attention first.
- **Websites:** list, add and edit (schedule, page selection, checks, form mode, recipients, email
  toggle), and a detail page with a score-over-time chart, history table, pages ever checked, and
  the configuration.
- **Scans:** a table of every scan with live progress, and the report for each one: summary cards,
  issues by check, by page or grouped by issue, evidence and screenshots, ignore and reopen. A
  report says which website it is a check of, or that it is a one-off scan.
- **Settings:** API keys (shown once), allowed domains, webhook secret, scan defaults.
- **Quality bar:** calm, Linear-like design, light and dark themes, skeleton, empty and error
  states everywhere, keyboard reachable, WCAG AA contrast.

## 10. Definition of done for the monitoring pivot

- A user can register a website, choose "monthly, 8 random pages, homepage always included", add
  two recipients, and from then on get an emailed report on schedule with no further action.
- The email is a designed dashboard summary, and renders correctly in Gmail and Outlook.
- A full one-off scan still works unchanged through the dashboard and the API.
- n8n and monday.com can still start a check, now optionally of a registered website, and receive
  the completed callback.

## 11. Out of scope

- Multi-tenant accounts and billing. Beacon runs for one team.
- Checking pages behind a login.
- Performance or accessibility auditing beyond the checks above.
- Anything that changes a customer's site. Beacon reads, and submits forms only when told to.
