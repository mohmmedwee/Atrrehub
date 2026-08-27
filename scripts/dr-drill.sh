#!/usr/bin/env bash
# Run a disaster recovery drill: take a backup, restore it into a scratch
# database, and report whether it came back whole.
#
# This is the thing the runbook asked for and nobody was doing. Run it from CI
# on a schedule and the "untested backup" line in the runbook stops being an
# aspiration.
set -euo pipefail
cd "$(dirname "$0")/.."

API="${API_URL:-http://localhost:4000}"
EMAIL="${ADMIN_EMAIL:-owner@atrrehub.demo}"
PASSWORD="${ADMIN_PASSWORD:-Str0ngPassword!23}"

curl -sf "$API/healthz" >/dev/null || { echo "The API is not running on $API" >&2; exit 1; }

TOKEN=$(curl -sf -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" |
  node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>process.stdout.write(JSON.parse(b).data.accessToken))')

echo "▸ Taking a backup…"
BACKUP=$(curl -sf -X POST "$API/api/v1/dr/backups" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"full","retentionDays":30}')
ID=$(echo "$BACKUP" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>process.stdout.write(JSON.parse(b).data.id))')
echo "  $ID"

echo "▸ Restoring it into a scratch database…"
RESULT=$(curl -sf -X POST "$API/api/v1/dr/backups/$ID/verify" -H "authorization: Bearer $TOKEN")

echo "$RESULT" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk)).on("end", () => {
  const record = JSON.parse(raw).data;
  const checks = (record.verification || {}).checks || [];
  for (const check of checks) {
    const mark = check.passed ? "  ✓" : "  ✗";
    console.log(`${mark} ${check.name}: expected ${check.expected}, got ${check.actual}`);
  }
  console.log("");
  if (record.status === "verified") {
    console.log(`Backup ${record.id} is restorable.`);
    process.exit(0);
  }
  console.error(`DRILL FAILED: ${record.error || "one or more checks failed"}`);
  process.exit(1);
});
'
