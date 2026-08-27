# Resilience runbook

Companion to `runbooks.md`, covering the queue tier and the database.

## Dead-lettered jobs

A job that exhausts its five attempts is written to `dead_letters` and counted by
`atrrehub_dead_letters_total{queue}`. Before this existed, BullMQ kept the failed job in
Redis for a day and then forgot it — nobody could list what had been lost, and nobody could
run it again. An ingestion job that failed during an outage meant a customer's documents
were never indexed, silently and permanently.

### Responding

```
GET  /api/v1/resilience/dead-letters/summary       outstanding per queue
GET  /api/v1/resilience/dead-letters               the outstanding ones by default
GET  /api/v1/resilience/dead-letters/{id}          payload and stack
POST /api/v1/resilience/dead-letters/{id}/replay   put it back on its queue
POST /api/v1/resilience/dead-letters/{id}/discard  record that it must never run again
```

1. Read the error. Most dead letters are one of two things: a dependency that was down (fix
   it, then replay) or a job referring to something that no longer exists (discard, with a
   note saying why).
2. A replay re-enqueues into the job's **original tenant**, not the operator's — the
   payload carries its own context.
3. A replay that fails again dead-letters as a **new row**. The original stays marked as
   replayed, so the third time the same job appears you can see it has been tried twice.
4. Discarding requires a note. It is the record of a decision, and "why did nobody run
   this" is the question asked six months later.

### Alerting

Alert on `atrrehub_dead_letters_total` increasing, per queue. A single dead letter is
usually a data problem; a rate is an outage.

## Read replica

Set `DATABASE_REPLICA_URL` to route analytics and report queries to a standby.
`DB_REPLICA_MAX_LAG_SECONDS` (default 30) records how stale is acceptable.

```
GET /api/v1/resilience/replica    { configured, lagSeconds }
```

Only reads that tolerate staleness are routed there: dashboards and reports, both of which
aggregate over a window that has already closed. **Saved-report CRUD and every other write
path stays on the primary** — routing a read-after-write at a replica fails outright on a
read-only standby, and succeeds misleadingly on one that is merely stale.

With no replica configured, `readOnly()` returns the primary, so the same code is correct
on a single node.

If lag climbs: reports are stale but nothing is incorrect, because nothing depends on a
replica read for a decision. Unset `DATABASE_REPLICA_URL` and restart to fall back to the
primary.

## Partitioned tables

`api_request_logs` is range-partitioned by month, with three months' retention. The list
and the retention windows live in `apps/api/src/modules/resilience/partitions.ts`.

```
GET  /api/v1/resilience/partitions           what exists, and what is retained
POST /api/v1/resilience/partitions/maintain  create missing, drop expired, now
```

A daily job at 02:00 creates partitions **two months ahead** and drops those entirely
outside the retention window. Two months rather than one because the failure mode is total:
a range-partitioned table with no partition for today rejects every insert, so a single
missed run at a month boundary would stop the platform writing request logs.

The job is idempotent; running it by hand is safe.

### Converting a table

```bash
scripts/partition-table.sh <table> [timestamp-column]
```

Postgres cannot partition in place, so the script builds a partitioned twin, copies the
rows and swaps the names in one transaction, then verifies the row count. The original is
left as `<table>_unpartitioned` for you to drop once the application has been checked.

It refuses two cases, and both matter:

- **The table is not declared in `partitions.ts`.** A partitioned table the maintenance job
  does not know about stops accepting inserts when the month turns.
- **Something holds a foreign key to it.** Postgres will not point a foreign key at a
  partitioned table unless the key includes the partition column, so partitioning such a
  table means changing every one of those relationships — a schema change, not a
  maintenance decision.

This is why `messages`, `audit_events` and `conversation_events` are **not** partitioned
despite being the obvious candidates by volume: each is referenced by other tables, or
references one in a way the partition key would have to carry. Converting them is a schema
change with a migration path of its own, not something this script should do quietly.
