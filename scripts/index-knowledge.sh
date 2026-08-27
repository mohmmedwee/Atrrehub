#!/usr/bin/env bash
# Index the seeded knowledge articles so retrieval — and anything that depends
# on it — actually returns something.
#
# The seed writes articles directly to the database, which leaves them published
# but unindexed: chunking and embedding happen in the API's ingestion pipeline,
# not in a standalone Prisma script. Until this runs, every agent answer is
# refused for being ungrounded, which looks like a broken agent rather than an
# empty index.
set -euo pipefail
cd "$(dirname "$0")/.."

API="${API_URL:-http://localhost:4000}"
EMAIL="${SEED_EMAIL:-owner@atrrehub.demo}"
PASSWORD="${SEED_PASSWORD:-Str0ngPassword!23}"

curl -sf "$API/healthz" >/dev/null || {
  echo "The API is not running on $API — start it with 'pnpm dev' first." >&2
  exit 1
}

TOKEN=$(curl -sf -X POST "$API/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" |
  node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>process.stdout.write(JSON.parse(b).data.accessToken))')

# `mapfile` is bash 4, and macOS ships bash 3.2 — the version every Mac
# contributor gets from /bin/bash. Read the ids into a plain array instead, so
# this runs on the shell people actually have rather than the one Linux has.
ARTICLES=()
while IFS= read -r id; do
  [ -n "$id" ] && ARTICLES+=("$id")
done < <(
  curl -sf "$API/api/v1/knowledge/articles?limit=100" -H "authorization: Bearer $TOKEN" |
    node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{
      const rows = JSON.parse(b).data ?? [];
      for (const row of rows) if (row.state === "published") console.log(row.id);
    })'
)

if [ ${#ARTICLES[@]} -eq 0 ]; then
  echo "No published articles to index."
  exit 0
fi

for id in "${ARTICLES[@]}"; do
  curl -sf -X POST "$API/api/v1/knowledge/articles/$id/publish" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' >/dev/null
  echo "indexed $id"
done

echo "${#ARTICLES[@]} article(s) indexed — retrieval is live."
