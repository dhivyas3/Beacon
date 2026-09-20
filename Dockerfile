# syntax=docker/dockerfile:1.7
#
# One Dockerfile, three runtime targets: api, worker, web.
#   docker build --target api    -t qa-hub-api .
#   docker build --target worker -t qa-hub-worker .
#   docker build --target web    -t qa-hub-web .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV CI=true
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# ---- build: install everything and compile every package -----------------------------------
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build

# ---- api ------------------------------------------------------------------------------------
FROM build AS api
ENV NODE_ENV=production
EXPOSE 3000
# Apply migrations, then start. `prisma migrate deploy` is idempotent.
CMD ["sh", "-c", "pnpm --filter @qa-hub/db migrate && node apps/api/dist/main.js"]

# ---- worker ---------------------------------------------------------------------------------
FROM build AS worker
ENV NODE_ENV=production
# Headless Chromium and the system libraries it needs. Cached as its own layer.
RUN pnpm --filter @qa-hub/worker exec playwright install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/*
CMD ["node", "apps/worker/dist/main.js"]

# ---- web: static files served by nginx, /api proxied to the api service ---------------------
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
