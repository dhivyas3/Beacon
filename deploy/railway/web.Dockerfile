# syntax=docker/dockerfile:1.7
#
# Railway: the dashboard, static files served by nginx, with /api proxied to the api-worker
# service over Railway's private network. Build from the repository root, with this file as the
# Dockerfile path:
#   docker build -f deploy/railway/web.Dockerfile -t beacon-web .

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile
# The full turbo build, same as the root Dockerfile: apps/web's own build assumes its workspace
# dependencies (packages/shared and the rest) are already compiled, and turbo orders that for us.
RUN pnpm build

FROM nginx:1.27-alpine
RUN apk add --no-cache gettext
COPY deploy/railway/nginx.conf.template /etc/nginx/templates/nginx.conf.template
COPY deploy/railway/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
ENTRYPOINT ["/docker-entrypoint.sh"]
