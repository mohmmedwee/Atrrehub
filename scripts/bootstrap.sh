#!/usr/bin/env bash
# One command from a fresh clone to a running platform with demo data.
set -euo pipefail
cd "$(dirname "$0")/.."

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }

info "Checking prerequisites"
command -v node >/dev/null || { echo "Node.js 22+ is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm 10+ is required (corepack enable)" >&2; exit 1; }

if [ ! -f .env ]; then
  info "Creating .env from the template"
  cp .env.example .env
  # Generate real secrets rather than shipping the placeholders.
  if command -v openssl >/dev/null; then
    for key in JWT_SECRET ENCRYPTION_KEY WIDGET_TOKEN_SECRET; do
      value=$(openssl rand -hex 32)
      sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
    done
    echo "    generated JWT_SECRET, ENCRYPTION_KEY and WIDGET_TOKEN_SECRET"
  fi
fi

info "Installing dependencies"
pnpm install

info "Starting Postgres, Redis, MinIO and Mailpit"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker compose -f infra/docker/docker-compose.yml up -d
  echo "    waiting for Postgres…"
  for _ in $(seq 1 60); do
    docker compose -f infra/docker/docker-compose.yml exec -T postgres pg_isready -U atrrehub >/dev/null 2>&1 && break
    sleep 1
  done
else
  echo "    Docker is unavailable — expecting Postgres (with pgvector) and Redis to be running locally"
fi

info "Applying database migrations"
pnpm --filter @atrrehub/api db:deploy

info "Seeding the demo organization"
pnpm --filter @atrrehub/api db:seed

cat <<'DONE'

Ready.

  pnpm dev            start the API and web app together
  pnpm dev:api        API only          → http://localhost:4000
  pnpm dev:web        web only          → http://localhost:3000

  API docs            http://localhost:4000/api/docs
  Widget preview      http://localhost:3000/widget-demo
  Mail catcher        http://localhost:8025

  Sign in as owner@atrrehub.demo / Str0ngPassword!23

DONE
