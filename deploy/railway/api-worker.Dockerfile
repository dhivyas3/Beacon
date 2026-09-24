# syntax=docker/dockerfile:1.7
#
# Railway: the api and the worker in one service, sharing one filesystem (a Railway Volume mounted
# at /data/storage) for screenshots. Railway volumes attach to exactly one service, so the pair that
# reads and writes the same files has to be that one service. See docs/RAILWAY.md.
#
# Build from the repository root, with this file as the Dockerfile path:
#   docker build -f deploy/railway/api-worker.Dockerfile -t beacon-api-worker .

FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV CI=true
ENV NODE_ENV=production
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build

# Headless Chromium and the system libraries it needs, for the worker half of this image.
RUN pnpm --filter @beacon/worker exec playwright install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/*

COPY deploy/railway/run-api-and-worker.sh /usr/local/bin/run-api-and-worker.sh
RUN chmod +x /usr/local/bin/run-api-and-worker.sh

EXPOSE 3000
# dumb-init reaps the browser processes Chromium leaves behind and forwards signals, so Railway's
# restarts and deploys stop the container cleanly instead of leaving zombies.
ENTRYPOINT ["dumb-init", "--"]
CMD ["/usr/local/bin/run-api-and-worker.sh"]
