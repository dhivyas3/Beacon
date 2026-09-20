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
- Commit messages follow Conventional Commits (`feat(api): ...`, `fix(worker): ...`).
- Never scan a real third-party site in development or tests; use `fixtures/site`.

## Windows dev notes

This repo was bootstrapped on Windows without Docker. `pnpm dev:services` and the test kit
use `embedded-postgres` and `redis-server` from `REDIS_SERVER_BIN` (see `.env.example`).
Playwright needs `pnpm exec playwright install chromium` once.
