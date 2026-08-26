#!/usr/bin/env bash
# Start the API in the background for local verification, replacing any previous run.
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
PORT="${API_PORT:-4000}"
if lsof -ti ":$PORT" >/dev/null 2>&1; then
  lsof -ti ":$PORT" | xargs -r kill -9
  sleep 1
fi
LOG="${API_LOG:-/tmp/atrrehub-api.log}"
setsid nohup node -r @swc-node/register src/main.ts > "$LOG" 2>&1 < /dev/null &
for _ in $(seq 1 40); do
  if curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    echo "api ready on :$PORT (log: $LOG)"
    exit 0
  fi
  sleep 1
done
echo "api failed to start; last log lines:" >&2
tail -30 "$LOG" >&2
exit 1
