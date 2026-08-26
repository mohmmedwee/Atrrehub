#!/usr/bin/env bash
# Start the API for local verification, replacing any previous run.
# Also ensures Postgres and Redis are up — this sandbox stops them between sessions.
set -euo pipefail
cd "$(dirname "$0")/.."

pg_isready -h localhost -p 5432 >/dev/null 2>&1 || sudo service postgresql start >/dev/null 2>&1 || true
redis-cli ping >/dev/null 2>&1 || sudo service redis-server start >/dev/null 2>&1 || true
for _ in $(seq 1 15); do
  pg_isready -h localhost -p 5432 >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1 && break
  sleep 1
done

PORT="${API_PORT:-4000}"
if lsof -ti ":$PORT" >/dev/null 2>&1; then
  lsof -ti ":$PORT" | xargs -r kill -9
  sleep 1
fi

LOG="${API_LOG:-/tmp/atrrehub-api.log}"
cd apps/api
setsid nohup node -r @swc-node/register src/main.ts > "$LOG" 2>&1 < /dev/null &
for _ in $(seq 1 45); do
  if curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    echo "api ready on :$PORT (log: $LOG)"
    exit 0
  fi
  sleep 1
done
echo "api failed to start; last log lines:" >&2
tail -30 "$LOG" >&2
exit 1
