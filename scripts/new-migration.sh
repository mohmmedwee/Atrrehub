#!/usr/bin/env bash
# Generate an additive Prisma migration from the current schema.
#
# `prisma migrate diff` wants to drop the generated columns and specialised
# indexes that live in hand-written SQL migrations — it cannot see them in
# schema.prisma, so every diff proposes deleting them. Slicing those lines out
# by eye is how an index gets dropped in production, so it is done here,
# deterministically, and the result is checked before it is written.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${1:?usage: new-migration.sh <name>}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DIR="apps/api/prisma/migrations/${STAMP}_${NAME}"

set -a; . ./.env; set +a
cd apps/api

RAW="$(mktemp)"
trap 'rm -f "$RAW"' EXIT
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "$RAW"

# Drop every destructive statement and the comment that introduces it. A
# migration this script writes can only ever add.
python3 - "$RAW" > "$RAW.clean" <<'PY'
import re, sys

raw = open(sys.argv[1]).read()
# Prisma emits "-- DropIndex\nDROP INDEX ...;" style pairs; remove the whole pair.
# The body must not run past the next `--` header: a lazy match that could
# cross one would swallow every additive statement between here and the next
# DROP anywhere in the file, and report "nothing to migrate".
cleaned = re.sub(
    r'--\s*(DropIndex|DropTable|DropColumn|DropEnum|AlterTable)\s*\n(?:(?!--)[^\n]*\n)*?[^\n]*\b(DROP\s+(INDEX|TABLE|COLUMN|TYPE)|DROP\s+CONSTRAINT)\b[^\n]*;\s*\n',
    '', raw, flags=re.IGNORECASE)
# Any stray destructive line that survived the pairing.
cleaned = '\n'.join(
    line for line in cleaned.split('\n')
    if not re.search(r'^\s*(DROP\s+(INDEX|TABLE|TYPE)|ALTER\s+TABLE[^;]*DROP\s+COLUMN)', line, re.IGNORECASE)
)
# Prisma's config banner is not SQL.
cleaned = '\n'.join(l for l in cleaned.split('\n') if not l.startswith('Loaded Prisma config'))
print(re.sub(r'\n{3,}', '\n\n', cleaned).strip())
PY

if grep -Eiq '^\s*(DROP|TRUNCATE)' "$RAW.clean"; then
  echo "Refusing to write: a destructive statement survived the filter." >&2
  grep -Ein '^\s*(DROP|TRUNCATE)' "$RAW.clean" >&2
  exit 1
fi

# An empty result is only believable when the diff itself was empty. Anything
# else means the filter ate a statement it should have kept, and reporting
# "nothing to migrate" would lose it silently.
if [ ! -s "$RAW.clean" ]; then
  if grep -Eiq '^\s*(ALTER|CREATE|INSERT|UPDATE)' "$RAW"; then
    echo "Refusing to write: the filter removed every additive statement." >&2
    grep -Ein '^\s*(ALTER|CREATE)' "$RAW" | head >&2
    exit 1
  fi
  echo "Nothing to migrate — the database already matches the schema."
  exit 0
fi

mkdir -p "../../$DIR"
cp "$RAW.clean" "../../$DIR/migration.sql"
echo "Wrote $DIR/migration.sql"
echo "Review it, then apply with: cd apps/api && npx prisma migrate deploy"
