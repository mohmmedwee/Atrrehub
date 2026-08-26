# syntax=docker/dockerfile:1.7
# Multi-stage build: the runtime image carries no toolchain and no source.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY . .
RUN pnpm --filter @atrrehub/api build
# Drop dev dependencies before they are copied into the runtime image.
RUN pnpm --filter @atrrehub/api --prod deploy /app/pruned

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini && addgroup -S atrrehub && adduser -S atrrehub -G atrrehub
WORKDIR /app

COPY --from=build --chown=atrrehub:atrrehub /app/pruned/node_modules ./node_modules
COPY --from=build --chown=atrrehub:atrrehub /app/apps/api/dist ./dist
COPY --from=build --chown=atrrehub:atrrehub /app/apps/api/prisma ./prisma
COPY --from=build --chown=atrrehub:atrrehub /app/apps/api/package.json ./package.json

USER atrrehub
ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards signals, so shutdown hooks actually run.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
