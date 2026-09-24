#!/bin/sh
# Runs migrations once, then the api and the worker side by side in one container (see
# api-worker.Dockerfile for why they share one). Plain POSIX sh: Debian's /bin/sh is dash, which
# has no `wait -n`, so this polls instead. If either process exits, for any reason, the other is
# stopped and the script exits non-zero, so Railway sees the container as crashed and restarts the
# whole thing rather than carrying on with only half of it alive.
set -e

pnpm --filter @beacon/db migrate

# Creates the first admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD. Safe to run on every boot:
# the seed script itself is a no-op once that user exists, and it is skipped rather than crashing
# the deploy when the variables are not set (for instance on a redeploy after signing in and
# removing them).
if [ -n "$SEED_ADMIN_EMAIL" ] && [ -n "$SEED_ADMIN_PASSWORD" ]; then
  pnpm --filter @beacon/db seed
fi

node apps/worker/dist/main.js &
worker_pid=$!
node apps/api/dist/main.js &
api_pid=$!

# A signal from Railway (a redeploy, a stop) is forwarded to both, so each gets its own graceful
# shutdown (both main.ts files already drain running scans and finish in-flight requests on
# SIGTERM/SIGINT) instead of being killed outright.
trap 'kill "$worker_pid" "$api_pid" 2>/dev/null || true' TERM INT

while kill -0 "$worker_pid" 2>/dev/null && kill -0 "$api_pid" 2>/dev/null; do
  sleep 2
done

kill "$worker_pid" "$api_pid" 2>/dev/null || true
wait "$worker_pid" 2>/dev/null || true
wait "$api_pid" 2>/dev/null || true
exit 1
