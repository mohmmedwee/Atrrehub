# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN pnpm --filter @atrrehub/web build

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini && addgroup -S atrrehub && adduser -S atrrehub -G atrrehub
WORKDIR /app/apps/web

COPY --from=build --chown=atrrehub:atrrehub /app/node_modules /app/node_modules
COPY --from=build --chown=atrrehub:atrrehub /app/apps/web/node_modules ./node_modules
COPY --from=build --chown=atrrehub:atrrehub /app/apps/web/.next ./.next
COPY --from=build --chown=atrrehub:atrrehub /app/apps/web/public ./public
COPY --from=build --chown=atrrehub:atrrehub /app/apps/web/package.json ./package.json
COPY --from=build --chown=atrrehub:atrrehub /app/apps/web/next.config.mjs ./next.config.mjs

USER atrrehub
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
