#!/usr/bin/env bash
# Convert an append-only table to monthly range partitioning.
#
# Postgres cannot partition a table in place, so this creates a partitioned
# twin, moves the rows, and swaps the names inside one transaction. It is a
# maintenance operation, not a migration: Prisma cannot express partitioning,
# and running it automatically on deploy would rewrite a large table at the
# worst possible moment.
#
# Only for tables listed in apps/api/src/modules/resilience/partitions.ts —
# nothing may hold a foreign key to the table, because Postgres will not point
# one at a partitioned table unless the key includes the partition column.
set -euo pipefail
cd "$(dirname "$0")/.."

TABLE="${1:?usage: partition-table.sh <table> [timestamp-column]}"
COLUMN="${2:-created_at}"

set -a; . ./.env; set +a
DB="${DATABASE_URL%%\?*}"

if ! grep -q "table: '$TABLE'" apps/api/src/modules/resilience/partitions.ts; then
  echo "Refusing: $TABLE is not declared in partitions.ts." >&2
  echo "Add it there first — the maintenance job reads that list, and a partitioned" >&2
  echo "table it does not know about stops accepting inserts when the month turns." >&2
  exit 1
fi

REFERENCING=$(psql "$DB" -tAc "SELECT count(*) FROM pg_constraint WHERE confrelid='$TABLE'::regclass AND contype='f';")
if [ "$REFERENCING" != "0" ]; then
  echo "Refusing: $REFERENCING foreign key(s) point at $TABLE." >&2
  psql "$DB" -tAc "SELECT conrelid::regclass FROM pg_constraint WHERE confrelid='$TABLE'::regclass AND contype='f';" >&2
  exit 1
fi

ALREADY=$(psql "$DB" -tAc "SELECT count(*) FROM pg_partitioned_table p JOIN pg_class c ON c.oid=p.partrelid WHERE c.relname='$TABLE';")
if [ "$ALREADY" != "0" ]; then
  echo "$TABLE is already partitioned; nothing to do."
  exit 0
fi

ROWS=$(psql "$DB" -tAc "SELECT count(*) FROM \"$TABLE\";")
echo "Converting $TABLE ($ROWS rows) to monthly partitions on $COLUMN."

psql "$DB" -v ON_ERROR_STOP=1 <<SQL
BEGIN;

-- Locked for the whole swap. The table is append-only telemetry, so writers
-- block briefly rather than losing rows.
LOCK TABLE "$TABLE" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE "${TABLE}_partitioned" (LIKE "$TABLE" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
  PARTITION BY RANGE ("$COLUMN");

-- The primary key must include the partition column: Postgres cannot enforce
-- uniqueness across partitions without it being part of the key.
ALTER TABLE "${TABLE}_partitioned" DROP CONSTRAINT IF EXISTS "${TABLE}_partitioned_pkey";
ALTER TABLE "${TABLE}_partitioned" ADD PRIMARY KEY (id, "$COLUMN");

-- One partition per month the data actually spans, plus the two ahead that the
-- maintenance job would create. A gap anywhere is an insert with nowhere to go.
DO \$\$
DECLARE
  m date;
  lo date;
  hi date;
BEGIN
  SELECT date_trunc('month', COALESCE(min("$COLUMN"), now()))::date,
         date_trunc('month', now())::date + interval '2 months'
    INTO lo, hi FROM "$TABLE";
  m := lo;
  WHILE m <= hi LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      '${TABLE}_' || to_char(m, 'YYYY_MM'),
      '${TABLE}_partitioned',
      m, m + interval '1 month');
    m := (m + interval '1 month')::date;
  END LOOP;
END
\$\$;

INSERT INTO "${TABLE}_partitioned" SELECT * FROM "$TABLE";

ALTER TABLE "$TABLE" RENAME TO "${TABLE}_unpartitioned";
ALTER TABLE "${TABLE}_partitioned" RENAME TO "$TABLE";

COMMIT;
SQL

MOVED=$(psql "$DB" -tAc "SELECT count(*) FROM \"$TABLE\";")
if [ "$MOVED" != "$ROWS" ]; then
  echo "Row count changed during the swap: $ROWS before, $MOVED after. The old" >&2
  echo "table is still present as ${TABLE}_unpartitioned — investigate before dropping it." >&2
  exit 1
fi

echo "Converted. $MOVED rows across $(psql "$DB" -tAc "SELECT count(*) FROM pg_inherits i JOIN pg_class p ON p.oid=i.inhparent WHERE p.relname='$TABLE';") partitions."
echo
echo "The original is kept as ${TABLE}_unpartitioned. Verify the application, then:"
echo "  psql \"\$DATABASE_URL\" -c 'DROP TABLE ${TABLE}_unpartitioned'"
