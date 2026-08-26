# Operational runbooks

Written for whoever is on call, not for whoever wrote the code. Each entry
starts with how you know, then what to do.

---

## Deployment

### Standard release

1. CI green on the commit (`quality`, `integration`, `build`, `security`).
2. `helm upgrade --install atrrehub infra/helm/atrrehub --set image.tag=<version>`.
3. The pre-upgrade hook runs `prisma migrate deploy`. A failed migration aborts
   the release; no new pod serves traffic against a schema that did not apply.
4. Watch `atrrehub_http_errors_total` and p95 latency for ten minutes.

### Rollback

```bash
helm rollback atrrehub
```

Rolling back application code is always safe. **Rolling back a migration is
not** — expand-and-contract is the rule: add columns and backfill in one
release, stop writing the old column in the next, drop it in a third. If a
release must be reverted after a destructive migration, restore from PITR
instead (see below).

### Zero-downtime schema changes

- Adding a column: always nullable or with a default.
- Renaming: add the new column, dual-write, backfill, switch reads, drop later.
- Adding an index on a large table: create it `CONCURRENTLY` outside the hook.

---

## Incidents

### API returning 5xx

1. `kubectl logs -l app.kubernetes.io/component=api --tail=200` — every failure
   logs a `requestId`; ask the reporter for theirs and grep it.
2. Check `/readyz`. If `database: false`, the API is healthy and its dependency
   is not — go to the database entry.
3. Check `atrrehub_http_errors_total` by `route` and `code` to see whether it is
   one endpoint or everything.
4. If one endpoint, roll back. If everything, look at the datastores first.

### Database unavailable

Symptoms: `/readyz` reports `database: false`; pods stay running because
liveness deliberately does not probe the database.

1. Confirm from the database side (connections, CPU, storage, failover state).
2. If connections are exhausted, scale the API down to shed load, then back up.
3. Once recovered, readiness flips within ten seconds and traffic resumes with
   no restart.

### Redis unavailable

Rate limiting, presence, caching and queues degrade. The API keeps serving:
cache reads fall through to the database and rate limiting fails open. Queued
background work pauses and resumes when Redis returns — jobs are durable.

### Queue backlog

Symptoms: `atrrehub_queue_depth{state="waiting"}` climbing.

1. Identify the queue. Ingestion and quality are the usual causes — both make
   model calls.
2. Scale the worker deployment, or raise `WORKER_CONCURRENCY`.
3. If the backlog is in `execution`, check for a workflow stuck in a retry loop:
   `GET /api/v1/agents/executions?status=failed`.

### AI provider outage

The gateway fails over through the tenant's configured chain and ends at the
local provider, so conversations keep working with reduced quality rather than
stopping. Confirm with `atrrehub_ai_request_duration_seconds` by `provider`, and
with the "served by a fallback provider" warnings in the logs.

If a provider is down for an extended period, set the tenant's model route to a
working provider: `PUT /api/v1/ai/models`.

### SLA breaches spiking

1. `GET /api/v1/analytics/live` — is the queue depth or the agent count the
   problem?
2. If no agents are available, check presence and business hours: a calendar
   with no rules means 24×7, but a misconfigured calendar can close a queue
   unexpectedly.
3. Confirm the sweep is running: it logs `SLA sweep complete` each minute on
   whichever worker holds the lock.

### A tenant reports seeing another tenant's data

Treat as a **security incident**, not a bug report.

1. Capture the `requestId` and the exact resource identifiers.
2. Check the audit log for that organization and the API request log for that
   request id.
3. Run the isolation suite against the affected environment:
   `pnpm --filter @atrrehub/api test:e2e`.
4. If the suite passes, the leak is more likely in a raw SQL query than the
   query layer — the tenant guard does not cover `$queryRaw`. Grep for
   `queryRaw` and confirm each one filters on `organization_id`.
5. Enable RLS (`infra/sql/rls.sql`) as a containment measure while the root
   cause is found.

---

## Backup and recovery

### What is backed up

| Data | Method | Retention |
|---|---|---|
| PostgreSQL | Continuous WAL archiving with PITR | 30 days |
| Object storage | Cross-region replication | 90 days |
| Secrets | Secret manager's own versioning | per policy |
| Infrastructure | Helm values and Terraform in git | indefinite |

### Point-in-time restore

1. Identify the target timestamp — from the audit log for a data incident, or
   the deploy that preceded the problem.
2. Restore to a **new** cluster. Never restore over the live one.
3. Verify: row counts on `organizations`, `conversations` and `messages`, and
   spot-check an affected tenant.
4. Repoint `DATABASE_URL` and restart the API and workers.
5. Re-run `prisma migrate deploy` — a restore predating a migration needs it.

### Recovery objectives

| Tier | RPO | RTO |
|---|---|---|
| Enterprise | 5 minutes | 60 minutes |
| Business | 1 hour | 4 hours |
| Starter | 24 hours | 24 hours |

Test the restore path quarterly. An untested backup is a hypothesis.

---

## Routine operations

### Onboarding a tenant

Registration provisions everything automatically: eight system roles, an owner
membership, a default workspace, business hours, an SLA policy with per-priority
targets, a queue, a knowledge base, guardrails and working web-chat and email
accounts. Nothing further is required for the tenant to start.

### Rotating secrets

- **JWT signing key**: deploy with both old and new accepted, wait one refresh
  TTL (30 days) or force `DELETE /api/v1/auth/sessions` for all users, then
  remove the old key.
- **Encryption key**: re-encrypt integration and channel credentials before
  removing the old key — they are unreadable without it.
- **Provider API keys**: update the secret and restart; no data migration.

### Adding a channel

Implement `ChannelAdapter`, register it in `ChannelsModule`, and add the enum
value. Nothing in the interaction engine changes — that is the point of the
interface.

### Investigating an AI answer

`GET /api/v1/agents/executions/{id}` returns the whole trace: every node with
its input and output, the model used, tokens and cost per step, the retrieved
citations, every tool call, and every guardrail decision. "Why did the agent say
that?" is answerable without reading a log.

---

## Monitoring

Alert on these; ignore the rest until they matter.

| Signal | Threshold | Means |
|---|---|---|
| `atrrehub_http_errors_total{code="internal_error"}` | > 1% of requests, 5 min | Something is broken |
| p95 `atrrehub_http_request_duration_seconds` | > 1s, 10 min | Degrading |
| `atrrehub_queue_depth{state="waiting"}` | > 1000, 15 min | Workers cannot keep up |
| `atrrehub_sla_breaches_total` | rate doubles | Staffing or routing problem |
| `atrrehub_workflow_failures_total` | > 5% of executions | A published agent is broken |
| `atrrehub_guardrail_blocks_total{action="block"}` | sudden spike | Attack, or an over-tight policy |
| `atrrehub_ai_cost_usd_total` | > 80% of the monthly ceiling | Budget exhaustion ahead |
| `/readyz` failing | 2 consecutive | Dependency down |

Metrics are exposed at `/metrics` in Prometheus exposition format. Traces go to
the OTLP endpoint when `OTEL_ENABLED=true`.
