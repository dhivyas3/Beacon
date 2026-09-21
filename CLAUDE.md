# QA Hub - working notes for Claude Code

Read `docs/PLAN.md` for the phase plan and `docs/DECISIONS.md` for decisions already made.
Do not re-litigate decisions; append a new entry if you must change one.

## Stack (pinned on purpose)

| Area | Choice |
| --- | --- |
| Runtime | Node 22 (`.nvmrc`), pnpm 10 (`packageManager` field), Turborepo 2 |
| Language | TypeScript 5.9, `strict: true`, `noUncheckedIndexedAccess`, ESM only (`"type": "module"`, `.js` import suffixes in Node packages) |
| API | Fastify 5, Zod 4 via `fastify-type-provider-zod`, `@fastify/swagger` (OpenAPI 3.1 at `/api/docs`), pino |
| Worker | BullMQ 5 + ioredis 5, Playwright (Chromium), undici 7 |
| Web | React 19, Vite 7, React Router 7, TanStack Query 5, Tailwind 4, shadcn-style components (hand-written in `apps/web/src/components/ui`), Recharts 3, lucide-react |
| Data | Prisma 6 + PostgreSQL 16, Redis 7 |
| Tests | Vitest 3 (unit + integration), Playwright Test (e2e) |
| Lint | ESLint 9 flat config (`eslint.config.js`), typescript-eslint type-aware rules, Prettier 3 |

## Commands (run from repo root)

```
pnpm install                 # install everything (pnpm 10: build scripts are allow-listed in pnpm-workspace.yaml)
pnpm build                   # turbo build (shared packages must be built before typecheck/tests of apps)
pnpm typecheck               # tsc --noEmit in every package
pnpm lint                    # eslint + prettier --check
pnpm format                  # prettier --write
pnpm test                    # vitest in every package (needs Postgres + Redis, see below)
pnpm e2e                     # (Phase 6) Playwright end-to-end suite
pnpm dev                     # api + worker + web in watch mode
pnpm dev:services            # embedded Postgres (5432) + Redis (6379) without Docker
pnpm db:migrate              # prisma migrate deploy
pnpm db:migrate:dev --name x # create a new migration (needs a running Postgres)
pnpm db:seed                 # create the first admin from SEED_ADMIN_* env vars
pnpm --filter @qa-hub/fixtures serve   # run the fixture site by hand on :4010
docker compose up --build    # full system: postgres, redis, api, worker, web (http://localhost:8080)
```

Tests that need infrastructure use `@qa-hub/testkit`: if `DATABASE_URL` / `REDIS_URL` are set
they are used (CI does this with service containers); otherwise an embedded Postgres and a
local `redis-server` (from `PATH` or `REDIS_SERVER_BIN`) are started on random ports.

## Conventions

- The API contract lives in `packages/shared/src/schemas/*`. Never define a request/response
  shape anywhere else. Fastify routes reference these schemas so OpenAPI stays accurate.
- All IDs are prefixed nanoids from `newId('scn')` in `@qa-hub/shared` (`usr_`, `ses_`,
  `key_`, `dom_`, `scn_`, `pg_`, `iss_`, `chk_`, `whd_`).
- All API errors are `{ error: { code, message, details? } }`. Throw `ApiError` from
  `apps/api/src/lib/errors.ts`; the global error handler maps it to the envelope.
- Every route declares `config: { auth: ... }` (a scope such as `scans:read`, `admin`,
  `session`, or `false`). The auth plugin enforces it. No route is public by accident.
- Outbound HTTP from api/worker goes through `@qa-hub/net` (`safeFetch`). Never call
  `fetch`/`undici.request` directly against user-supplied URLs.
- Checks implement `Check` from `apps/worker/src/checks/types.ts` and are registered in
  `apps/worker/src/checks/index.ts`. One file per check. Tests run each check against
  `fixtures/site`.
- Web: pages under `src/pages`, API hooks under `src/api`, shared UI in `src/components/ui`.
  Microcopy in sentence case, verb-first buttons. Every async view has skeleton, empty and
  error states.
- Web data goes through `apps/web/src/api/client.ts` (`api`, `ApiClientError`) and the TanStack Query hooks in `api/hooks.ts` (`keys` holds every query key). Components never call `fetch`. Active scans poll (1s detail, 2s list); nothing polls when idle.
- Web colours are CSS variables in `src/index.css` (light and dark). Use the semantic Tailwind tokens (`text-fg`, `bg-surface`, `text-critical-text`), never raw hex values, so both themes and contrast stay correct.
- Web tests use `fakeApi` from `src/test/fake-api.ts` (an in-memory `fetch`, keyed `'GET /scans/:id'`, records calls) and `renderApp(route)` from `src/test/render.tsx`. Find things by role and accessible name, as a person would. A fake route nobody registered answers 404, so a forgotten route fails loudly.
- Every `CheckType` has a check in the worker, so the UI offers all of them. If you add a new check type, add it to `CHECK_TYPES` in shared, register the check, and add fixture pages for it.
- Commit messages follow Conventional Commits (`feat(api): ...`, `fix(worker): ...`).
- Never scan a real third-party site in development or tests; use `fixtures/site`. Worker tests keep DNS and Chromium offline with `offlineResolver` and `OFFLINE_BROWSER_ARGS` from `apps/worker/src/test/harness.ts`.
- A check is one file in `apps/worker/src/checks/` exporting a `Check` (`run` per page, optional `finalize` once per scan), registered in `checks/index.ts`. Keep the analysis in pure functions so it can be unit tested without a browser.
- Code that runs inside the browser page (`scan/snapshot-script.ts`) is a plain JavaScript string. Never pass a TypeScript function to `page.evaluate`: bundlers inject helpers that do not exist in the page.
- A check that interacts with a page (`forms`) must never do so on the page the other checks share. Open a scratch page in the same browser context (`browserPage.context().newPage()`) so the SSRF guard applies and the main page stays untouched for screenshots. In `validate_only` mode, block every non-GET request in that scratch page and assert in tests that the fixture site received nothing.
- A check that needs the whole site keeps per-scan state in a `WeakMap` keyed by `context.scan` and reports in `finalize` (see `seo.ts`), so state cannot leak between scans or outlive a failed one.
- A check may attach its own screenshot to a finding with `IssueDraft.screenshotPng` when the main page cannot show the problem (for example, a form's page after submitting it).
- Every Playwright call in `BrowserSession.load` goes through `abortable(promise, signal)`, because a call in flight when a context is closed may never settle and would wedge a stopping scan.
- Never type a backslash-heavy regex through a shell command or heredoc; write the file with the editor tool. Prefer patterns that need no escapes (`[^a-zA-Z0-9]+`).
- Everything the worker does to a scan row must be conditional on the status (`updateMany` with a `where` on status), so a scan cancelled or failed elsewhere is never overwritten.

## Windows dev notes

This repo was bootstrapped on Windows without Docker. `pnpm dev:services` and the test kit
use `embedded-postgres` and `redis-server` from `REDIS_SERVER_BIN` (see `.env.example`).
Playwright needs `pnpm --filter @qa-hub/worker exec playwright install chromium` once.
