# Atrrehub

An AI-native, multi-tenant omnichannel Customer Experience and Contact Center
platform. The AI Agent and Workflow Runtime are the centre of the architecture,
not an add-on: voice, chat and automation are entry points into one durable
runtime that draws on RAG, tools and memory, and hands off to humans when it
should.

Built from the 51-phase product plan (Phase 0 – Phase 50) in
[`docs/product/prd.md`](docs/product/prd.md). The MVP boundary the plan defines
(§52) is complete end to end, along with much of Release 2 and Release 3.

**Delivery status: 30 phases built, 11 partial, 6 schema only, 4 not built.**
[`docs/product/roadmap.md`](docs/product/roadmap.md) lists every phase with its
evidence and its named gaps.

---

## Quick start

```bash
./scripts/bootstrap.sh   # installs, starts datastores, migrates, seeds
pnpm dev                 # API on :4000, web on :3000
```

Then sign in at <http://localhost:3000> as `owner@atrrehub.demo` /
`Str0ngPassword!23`.

| Surface | URL |
|---|---|
| Agent workspace | <http://localhost:3000/workspace> |
| AI Studio | <http://localhost:3000/ai> |
| Analytics | <http://localhost:3000/analytics> |
| Admin console | <http://localhost:3000/admin> |
| Widget preview | <http://localhost:3000/widget-demo> |
| API reference | <http://localhost:4000/api/docs> |
| Mail catcher | <http://localhost:8025> |

**No AI provider key is required.** A deterministic local provider ships with
the platform, so agents, RAG, the copilot and quality control all run — and
their tests pass — with no external calls. Its replies are structurally correct
but not linguistically meaningful; set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
in `.env` and the same code paths produce real answers.

### Prerequisites

Node.js 22+, pnpm 10+, and either Docker or a local PostgreSQL 16 with the
`pgvector` extension plus Redis 7.

---

## What it does

**Customers arrive** on web chat, email or the API. Each channel implements one
`ChannelAdapter`, so channel specifics never leak into the core. Inbound
messages resolve or create a customer by normalized contact value, match to an
existing conversation by thread key, and are deduplicated against provider
redelivery.

**Routing** evaluates rules in order, then picks an assignee among agents who
are actually available, inside business hours, hold the required skills and
languages, and are below their concurrency ceiling. An AI-first queue routes to
its agent before any human is considered.

**The AI agent** retrieves from the tenant's knowledge with hybrid search,
answers with citations, and is checked at every stage: prompt injection on the
way in, PII and content policy on the way out, groundedness against the sources
it cited, and a confidence threshold that hands off to a person rather than
guessing. Every decision is recorded and visible in the execution debugger.

**Humans take over** with the full AI transcript, its citations and an
AI-written handoff summary already in the conversation, plus a copilot that
suggests grounded replies, rewrites, translates and recommends the next action —
always showing its sources so an agent is deciding on something they can check.

**Afterwards**, SLA clocks settle in working time, conversations are scored
against weighted quality scorecards with cited evidence, intelligence is
extracted for routing and analytics, and everything lands on the dashboards.

---

## Architecture

A modular monolith with clean domain boundaries and a separately scalable worker
tier. Each domain is a self-contained module; nothing crosses a boundary except
through a service interface or a domain event. That keeps the operational
surface small enough for private-cloud deployment while leaving each module
extractable when a tenant's scale demands it.

```
Internet → CDN/WAF → Load balancer
                         │
    ┌────────────────────┴────────────────────┐
    │  web (Next.js)   api (NestJS/Fastify)   │
    │                  realtime (WebSocket)   │
    │                  workers (BullMQ)       │
    └────────────────────┬────────────────────┘
                         │
     PostgreSQL + pgvector · Redis · Object storage
```

Full detail in [`docs/architecture/overview.md`](docs/architecture/overview.md).

### Tenant isolation

Every request resolves `User → Organization → Workspace → Resource`, and
isolation is enforced in three layers:

1. **Request context** — an AsyncLocalStorage-backed tenant scope.
2. **Query layer** — a Prisma extension derives the tenant-owned model set from
   the generated schema, constrains every query and stamps every write. A
   tenant-scoped query issued with no organization in scope **fails loudly**
   rather than silently reading across tenants.
3. **Row-level security** — optional Postgres RLS for regulated tenants
   (`infra/sql/rls.sql`).

A resource in another tenant returns `404`, never `403` — existence is not
disclosed across the boundary. This is verified by integration tests that run
two real tenants against a real database on every CI run.

---

## Repository layout

```
apps/
  api/                  NestJS API, realtime gateway and worker tier
    prisma/             schema (88 tables), migrations, seed
    src/core/           tenancy, errors, events, queues, storage, crypto, metrics
    src/modules/        one directory per bounded context
  web/                  Next.js workspace, AI studio, analytics, admin, widget
docs/                   product, architecture, API, events, security, AI, UX
infra/
  docker/               local datastores
  helm/atrrehub/        production chart (API, workers, web, migrations)
  sql/                  extensions and optional RLS policies
scripts/                bootstrap and development helpers
```

---

## Development

```bash
pnpm dev                 # API and web together
pnpm typecheck           # every package
pnpm test                # unit tests
pnpm test:e2e            # integration tests, including tenant isolation
pnpm db:migrate          # create a migration
pnpm db:seed             # reset and reseed the demo organization
pnpm infra:up            # datastores only
```

### Testing

| Suite | Command | Covers |
|---|---|---|
| Unit | `pnpm test` | Permission evaluation and role escalation, crypto, business-hours arithmetic across timezones and holidays, conversation lifecycle, contact normalization, routing conditions, RAG chunking and fusion, guardrail detectors, the workflow expression evaluator |
| Integration | `pnpm test:e2e` | Tenant isolation across read, write, delete, list and forged headers; registration and provisioning; refresh-token rotation and reuse detection; deny-by-default authorization; API key scoping |

The guardrail and expression suites are deliberately adversarial: they assert
that the injection detector does not flag "show me the instructions for
returning an item", that the PII detector Luhn-validates card numbers rather
than masking order references, that tool egress refuses the cloud metadata
endpoint, and that the expression evaluator cannot be made to execute code.

---

## Configuration

All configuration is environment variables, validated once at boot — a
misconfigured deployment fails immediately rather than at the first request that
happens to touch the missing value. See [`.env.example`](.env.example) for the
full list.

The values that matter most:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL 16 with `pgvector` |
| `REDIS_URL` | Cache, rate limits, presence, locks, queues |
| `JWT_SECRET`, `ENCRYPTION_KEY` | Generate with `openssl rand -hex 32` |
| `AI_DEFAULT_PROVIDER` | `local` (default), `openai`, `azure_openai`, `anthropic` |
| `WORKERS_ENABLED` | `false` on API pods, `true` on worker pods |

---

## Deployment

```bash
helm upgrade --install atrrehub infra/helm/atrrehub \
  --set secrets.existingSecret=atrrehub-secrets \
  --set ingress.hosts.api=api.example.com \
  --set ingress.hosts.web=app.example.com
```

The chart deploys the API, a separate worker tier (so a long ingestion job never
competes with request latency), the web app, and a pre-upgrade migration hook —
so a failed migration aborts the release rather than leaving a half-upgraded
cluster. Containers run non-root with a read-only root filesystem and all
capabilities dropped.

Liveness probes deliberately do not check the database: a database blip should
not restart every pod and turn a brownout into an outage. Readiness does check
it, so traffic stops instead.

See [`docs/security/controls.md`](docs/security/controls.md) for the security
posture and [`docs/runbooks.md`](docs/runbooks.md) for operations.

---

## API

REST at `/api/v1`, documented at `/api/docs` in non-production. Conventions are
specified in [`docs/api/standards.md`](docs/api/standards.md):

- Bearer tokens, API keys or widget tokens, all normalizing to one principal
- Cursor pagination, stable under concurrent writes
- RFC 9457 problem details with stable machine-readable codes
- `Idempotency-Key` on creating requests; `If-Match` for optimistic locking
- Rate limits with separate buckets for auth, general API, AI and bulk work
- Webhooks signed with HMAC-SHA256 over `{timestamp}.{body}`

---

## Licence

Proprietary. All rights reserved.
