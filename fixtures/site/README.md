# Fixture site

A small site that deliberately contains every defect QA Hub looks for. Tests start it in-process with `startFixtureSite()`. To run it by hand:

```bash
pnpm --filter @qa-hub/fixtures serve   # http://127.0.0.1:4010, external site on :4011
```

Scan it with `ALLOW_LOCAL_TARGETS=true` and `127.0.0.1` on the allowed domains list. It is never reachable from the public internet, and QA Hub refuses to scan private addresses unless that test-only override is set.

| Path | What is wrong or notable |
| --- | --- |
| `/` | Broken image, lazy-loaded broken image below the fold, broken CSS background, broken `srcset` candidate, image without `alt`, image on a staging host, links to staging, external, redirecting, missing and HEAD-hostile URLs |
| `/about` | Healthy. Links to `/orphan` |
| `/products/1..3` | Healthy, but share a broken logo and footer link with other pages, and form a page template |
| `/contact` | Healthy, no shared header |
| `/console-errors` | `console.error`, an uncaught exception, a failing `fetch` and a script that 404s |
| `/no-meta` | No title, description, canonical, h1 or Open Graph tags, plus an accidental `noindex` |
| `/form-good` | Working form with validation and a success message |
| `/form-broken` | Form with no validation that accepts anything |
| `/form-500` | Form whose endpoint returns 500 |
| `/orphan` | Linked from `/about` but missing from the sitemap |
| `/sitemap-only` | In the sitemap but not linked from anywhere |
| `/old-page` | 301 to `/about` |
| `/redirect-chain/1` | Four redirects before reaching `/about` |
| `/missing-page` | 404. Linked from every page footer |
| `/no-head`, `/forbidden-head` | HEAD answers 405 or 403, GET answers 200 |
| `/busy-internal` | 429 with `Retry-After: 0` twice, then 200 |
| `/sitemap.xml` | A sitemap index pointing to `/sitemap-pages.xml` |

The external site answers `/ok.html` (200), `/gone` (404), `/busy` (429 twice, then 200) and `/blocked` (403).
