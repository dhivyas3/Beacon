# Deploying Beacon to Railway

Beacon on Railway is four things in one project: a managed Postgres, a managed Redis, one
Docker service that runs the api and the worker together (`api-worker`), and one Docker service
that serves the dashboard and proxies `/api` to it (`web`). Only `web` gets a public URL; `n8n`,
`monday.com` and the browser all reach the API through it, at `/api/v1/...`, exactly as they do
with the Docker Compose setup in [DEPLOYMENT.md](DEPLOYMENT.md).

> **Not run against a real Railway account.** No Railway CLI or login was available in the
> environment this was prepared in, so nothing here has been deployed and clicked through end to
> end. The Dockerfiles build the same way the root `Dockerfile` already does (see
> `docs/DECISIONS.md`), and the pieces specific to Railway — private networking, the volume, the
> port Railway assigns — are the parts to watch on your first deploy. Where a setting might differ
> from what is written here, the Railway dashboard shows the actual value; use that.

## Why api and worker share one service

Screenshots live on disk under `STORAGE_DIR`, written by the worker and read back by the api (for
the screenshot route, and for CSV/PDF exports). Docker Compose shares one named volume between the
two containers. Railway volumes attach to exactly one service, so the pair that has to agree on the
same files is one service: `deploy/railway/api-worker.Dockerfile` runs both, `pnpm --filter
@beacon/db migrate` and (when `SEED_ADMIN_*` are set) the seed script once, then the worker in the
background and the api in the foreground, sharing the container's filesystem and one Volume mounted
at `/data/storage`. Do not run more than one replica of this service — a second replica would get
its own, empty volume, silently splitting screenshots across two disks. `web` has no volume and
scales freely.

If you outgrow this (want the api and worker to scale independently), the fix is to move
`@beacon/storage` to an S3-compatible backend, which the `Storage` interface was written to allow
(see `packages/storage/src/index.ts`) — nothing implements it yet.

## 1. What you need

- A [Railway](https://railway.app) account and the repository pushed to GitHub (already done:
  `dhivyas3/Beacon`).
- An email provider for reports — see "Email" below. Resend's sandbox sender needs no setup at all
  to start (see the note in this repo's own working notes on how that was verified).

## 2. Create the project

1. **New Project > Deploy from GitHub repo** and pick this repository. Railway will try to detect
   a service automatically; delete whatever it creates and add the four pieces below by hand, since
   this repo has three different Docker targets in one monorepo and auto-detection cannot know
   which one a given service should be.
2. **+ New > Database > Add PostgreSQL.** Railway provisions it and exposes `DATABASE_URL` as a
   variable on that plugin, referenceable from other services as `${{Postgres.DATABASE_URL}}`.
3. **+ New > Database > Add Redis.** Same idea: `${{Redis.REDIS_URL}}`.

## 3. The `api-worker` service

**+ New > GitHub Repo**, same repository. In its Settings:

- **Build > Root Directory**: `/` (the repository root — the Dockerfile needs the whole monorepo
  as its build context, to install every workspace package).
- **Build > Dockerfile Path**: `deploy/railway/api-worker.Dockerfile`. (If your Railway plan
  supports pointing a service at a committed config file, `deploy/railway/api-worker.railway.json`
  has the same build settings plus a health check and restart policy — otherwise set them here by
  hand.)
- **Networking**: leave this service with **no public domain**. It only needs to be reachable from
  `web`, over Railway's private network, which is on by default within a project.
- **Volumes > New Volume**, mount path `/data/storage`.
- **Variables** (Raw Editor, paste this, then fill in the placeholders):

  ```bash
  DATABASE_URL=${{Postgres.DATABASE_URL}}
  REDIS_URL=${{Redis.REDIS_URL}}
  PORT=3000
  HOST=0.0.0.0
  NODE_ENV=production
  STORAGE_DIR=/data/storage
  QUEUE_PREFIX=beacon

  # The web service's public URL, once you have it from step 4. Used to build report and status
  # links, and checked against the Origin header on cookie-authenticated requests.
  PUBLIC_URL=https://REPLACE-WITH-WEB-SERVICE-DOMAIN
  COOKIE_SECURE=true

  # openssl rand -hex 32 (or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  WEBHOOK_SIGNING_SECRET=REPLACE-WITH-A-LONG-RANDOM-VALUE

  # The first admin. Created on boot (idempotent), and only on boot — if you later remove these
  # two variables so a stray env var can never be used to reset the password, that is fine, it is
  # only read once at startup.
  SEED_ADMIN_EMAIL=admin@example.com
  SEED_ADMIN_PASSWORD=REPLACE-WITH-A-PASSWORD-AT-LEAST-12-CHARACTERS
  SEED_ADMIN_NAME=Admin

  # Never true here. It is for scanning the local fixture site in development only.
  ALLOW_LOCAL_TARGETS=false

  # Email — see "Email" below. This is the zero-DNS-setup option to start with.
  EMAIL_PROVIDER=resend
  EMAIL_FROM=onboarding@resend.dev
  EMAIL_FROM_NAME=Beacon
  RESEND_API_KEY=REPLACE-WITH-A-RESEND-KEY-STARTING-re_
  EMAIL_OUTBOX_DIR=/data/storage/outbox
  ```

  `PORT` is pinned deliberately (see "Private networking" below) rather than left for Railway to
  assign, so the address you give `web` in step 4 is predictable.

- Deploy. Watch the build logs for `email provider` and `worker started` — both come from the
  worker half, and `Server listening at` from the api half. `/api/v1/health` inside the container
  should answer once it is up; the health check path in `api-worker.railway.json` is already set to
  it.

## 4. The `web` service

Another **+ New > GitHub Repo**, same repository, alongside `api-worker`.

- **Build > Root Directory**: `/`.
- **Build > Dockerfile Path**: `deploy/railway/web.Dockerfile` (or point at
  `deploy/railway/web.railway.json` if your plan supports it).
- **Networking > Generate Domain** (or attach a custom one). This becomes both the address people
  open in a browser and the value you owed `PUBLIC_URL` on `api-worker` in step 3 — go back and set
  it now.
- **Variables**:

  ```bash
  API_INTERNAL_URL=http://api-worker.railway.internal:3000
  ```

  `api-worker` in that hostname is the **service name** as it appears in the Railway dashboard, not
  a fixed value — Railway's private network address for a service is always
  `<service-name>.railway.internal`. If you named the service something else, use that name, and
  the api-worker service's own **Settings > Networking** panel confirms the exact private address
  and port Railway has assigned it, which should match `3000` from the `PORT` you pinned in step 3.

Redeploy `web` after setting `PUBLIC_URL` on `api-worker`, if you deployed it before that was
final — nginx bakes nothing at build time here (the proxy target is read from the environment
when the container starts), so only `api-worker` needs a restart, not a rebuild, if this changes
later.

## 5. First sign-in

Open the `web` service's domain. Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, then:

1. **Settings > Allowed domains**: add every hostname Beacon may check.
2. **Settings > API keys**: create one for n8n or monday.com automation, if you use either. The
   `beaconUrl` those workflows call is the same `web` domain, with `/api/v1/...` appended — see
   [INTEGRATIONS.md](INTEGRATIONS.md).
3. Change the admin password from the account menu, then consider removing `SEED_ADMIN_PASSWORD`
   from the service's variables (see the note in step 3).
4. **Websites > Add website** to register your first one.

## Email

`EMAIL_PROVIDER=resend` with `EMAIL_FROM=onboarding@resend.dev` needs no domain verification and
was confirmed working end to end while building this: a real check, a real Resend API call, a real
delivered email. Its one limit is that Resend's shared sandbox domain only delivers to the email
address you used to sign up for Resend — fine for confirming the pipeline works, wrong for actual
recipients.

For real recipients, verify a domain you own at [resend.com/domains](https://resend.com/domains)
(SPF and DKIM records; Resend shows you exactly what to add), then set `EMAIL_FROM` to an address
on it, for example `reports@yourdomain.com`. `docs/DEPLOYMENT.md` has the same instructions in more
detail, including the SMTP alternative.

With nothing valid configured, Beacon writes every report to `$EMAIL_OUTBOX_DIR` as HTML instead of
sending it — harmless, but silent: nobody is told a report exists. Check a website's **Emails** tab
after its first scheduled check to confirm delivery actually happened.

## Chromium in a constrained container

Chromium wants far more `/dev/shm` than most container platforms give it (Docker's own default is
64 MB, and most PaaS containers cannot be told to raise it). The worker now always launches with
`--disable-dev-shm-usage`, which writes those temp files to `/tmp` instead — this was true before
Railway was in scope: Docker Compose was only getting away without it because of its own
`shm_size: '1gb'` override, which has no Railway equivalent (see `docs/DECISIONS.md`).

If a scan fails immediately with `Failed to launch the browser process! ... No usable sandbox!` in
the logs, the container's runtime is refusing to let Chromium set up its own sandbox. Set
`CHROMIUM_NO_SANDBOX=true` on `api-worker` and redeploy. It is not on by default anywhere,
including here, because it genuinely weakens isolation against a page that exploits a Chromium
bug — turn it on only if you hit that exact error.

## Backups

Railway's Postgres plugin has its own backup settings (Settings on the Postgres service). For the
`storage` volume (screenshots and, if you are using the `log` email provider, the outbox), Railway
volumes can be downloaded from the service's Volume settings, or reached with `railway ssh` for a
manual `tar`.

## Checklist before it is really live

Same as [DEPLOYMENT.md](DEPLOYMENT.md#6-security-checklist): `COOKIE_SECURE=true`, `PUBLIC_URL`
starting `https://`, `ALLOW_LOCAL_TARGETS=false`, a long random `WEBHOOK_SIGNING_SECRET`, only
hostnames you have permission to check on the allowed list, and revoke an API key the moment it
leaks.
