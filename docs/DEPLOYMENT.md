# Deploying Beacon

Beacon runs as five containers: Postgres, Redis, the API, the worker and the web app. This page
takes them from a fresh server to `https://beacon.example.com` with emailed reports.

> Not checked in this repository's environment: Docker was not available, so the compose files
> and the Caddy setup below have not been run. Everything they start (the API, worker and web app)
> is what `pnpm e2e` runs, without Docker. Expect to adjust a detail on first use, and read the
> compose file before running it.

## 1. What you need

- A Linux server with Docker and Docker Compose 2.24 or newer, 2 CPU and 4 GB of memory. Each scan
  drives a real Chromium, and `MAX_CONCURRENT_SCANS` (3 by default) decides how many at once.
- A domain name whose DNS points at the server, with ports 80 and 443 open.
- An email provider for reports: [Resend](https://resend.com), or any SMTP relay (Postmark and
  Amazon SES both offer one).

## 2. Configure

```bash
git clone <your fork> beacon && cd beacon
cp .env.example .env
```

Edit `.env`. These are the ones that matter in production:

| Variable | Set it to |
| --- | --- |
| `PUBLIC_URL` | `https://beacon.example.com`. Used for links in emails and callbacks, and for the API's origin check |
| `BEACON_DOMAIN` | `beacon.example.com`. Read by Caddy |
| `COOKIE_SECURE` | `true`. The session cookie is then only sent over HTTPS |
| `WEBHOOK_SIGNING_SECRET` | A long random value: `openssl rand -hex 32`. Signs callbacks and the links in emails. Changing it invalidates unsubscribe links already sent |
| `POSTGRES_PASSWORD` | A long random value |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | The first administrator. Change the password after signing in |
| `ALLOW_LOCAL_TARGETS` | `false`. It is only for scanning the fixture site on your own machine. With it on, Beacon can be pointed at private addresses |
| `EMAIL_PROVIDER`, `EMAIL_FROM`, `RESEND_API_KEY` or `SMTP_URL` | Your provider, below |

Leave `EMAIL_PROVIDER` blank with no key and Beacon writes emails to disk instead of sending them,
which is right while you set up and wrong for production. A website's page shows a failed or
skipped email with the reason.

### Email that reaches an inbox

Mail from a domain without authentication goes to spam. In your provider's dashboard verify the
domain you send from, and add the DNS records it shows:

- **SPF** and **DKIM**, which the provider gives you.
- **DMARC**: a `_dmarc` TXT record, starting with `v=DMARC1; p=none; rua=mailto:you@example.com`.

Then set `EMAIL_FROM` to an address on that domain, such as `reports@example.com`. Send the preview
(`pnpm email:preview`, or the HTML in `data/outbox`) to a Gmail, an Outlook and an Apple Mail
account and look at it before relying on it. Rendering in real clients has not been checked
(see DECISIONS.md).

## 3. Start it with HTTPS

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.caddy.yml up -d --build
```

Caddy gets a certificate for `BEACON_DOMAIN` by itself and renews it. The API applies database
migrations on start and creates the first administrator from `SEED_ADMIN_*`. Open
`https://beacon.example.com` and sign in.

`deploy/Caddyfile` sends everything to the web container, which serves the dashboard and passes
`/api` to the API. `flush_interval -1` matters: the live progress stream is held back by a proxy
that buffers. Behind another proxy (nginx, a load balancer), turn response buffering off for
`/api/v1/scans/*/events`. If it is buffered nothing breaks, the report polls every second instead.

## 4. First use

1. **Settings > Allowed domains**: add each hostname Beacon may check, or a wildcard such as
   `*.example.com`. Nothing else can be scanned or registered.
2. **Settings > API keys**: create one for n8n, with `scans:read` and `scans:write`. It is shown
   once.
3. **Websites > Add website**.

## 5. Running it

**Backups.** Everything that matters is in Postgres, plus screenshots in the `storage` volume.

```bash
docker compose exec postgres pg_dump -U beacon beacon | gzip > beacon-$(date +%F).sql.gz
docker run --rm -v beacon_storage:/data -v "$PWD":/backup alpine tar czf /backup/storage-$(date +%F).tgz /data
```

Redis holds only queued work. Losing it loses waiting jobs and nothing else: the scheduler plans
again from the database, and scans stuck in `running` are failed by the reaper after two minutes
without a heartbeat.

**Updating.** `git pull`, then the same `up -d --build` command. Migrations run on start and only
add to the schema.

**More capacity.** The worker is stateless: `docker compose up -d --scale worker=2`. Each worker
runs up to `MAX_CONCURRENT_SCANS` at once, and the scheduler is safe with several workers
(exactly one starts each due website).

**Health.** `GET /api/v1/health` says the API process is up. `GET /api/v1/ready` also checks Postgres and Redis, and answers `503` when either is down: point an uptime monitor at that one. The containers have health checks, so `docker compose ps` shows what is wrong.

**Logs.** `docker compose logs -f api worker`. Set `LOG_LEVEL=debug` for more.

## 6. Security checklist

- HTTPS only, `COOKIE_SECURE=true`, and `PUBLIC_URL` starts with `https://`.
- `ALLOW_LOCAL_TARGETS=false`.
- Postgres and Redis have no published ports. Keep it that way.
- `WEBHOOK_SIGNING_SECRET` and `POSTGRES_PASSWORD` are long and random, and `.env` is not in git.
- Only hostnames you own or have permission to check are on the allowed list.
- Beacon identifies itself as `BeaconBot/1.0` and is rate limited. If a site's firewall blocks it,
  allow that user agent for the schedule, rather than turning Beacon down.
- Revoke an API key in Settings the moment it leaks. Keys are stored hashed and cannot be read back.

## 7. Other ways to serve it

- **Behind an existing nginx, Traefik or load balancer**: publish only `web` (`WEB_PORT`), proxy to
  it, forward `X-Forwarded-Proto`, and disable response buffering for the event stream.
- **Without Docker**: run `pnpm build`, then `node apps/api/dist/main.js` and
  `node apps/worker/dist/main.js` with the same environment variables, and serve `apps/web/dist`
  with any static server that proxies `/api` to the API. The worker needs Chromium:
  `pnpm --filter @beacon/worker exec playwright install --with-deps chromium`.
