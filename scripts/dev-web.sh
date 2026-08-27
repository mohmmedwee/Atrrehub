#!/usr/bin/env bash
# Start the web app for local verification, replacing any previous run.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${WEB_PORT:-3000}"
if lsof -ti ":$PORT" >/dev/null 2>&1; then
  lsof -ti ":$PORT" | xargs -r kill -9
  sleep 1
fi

LOG="${WEB_LOG:-/tmp/atrrehub-web.log}"
cd apps/web
setsid nohup npx next dev -p "$PORT" > "$LOG" 2>&1 < /dev/null &
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/login" >/dev/null 2>&1; then
    echo "web ready on :$PORT (log: $LOG)"
    exit 0
  fi
  sleep 1
done
echo "web failed to start; last log lines:" >&2
tail -30 "$LOG" >&2
exit 1
