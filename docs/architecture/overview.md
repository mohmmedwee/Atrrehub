# Architecture overview

## Principle

> The AI Agent Platform is the centre of the product. Voice, chat and automation are
> entry points into one **Workflow Runtime**, which draws on **RAG**, **Tools** and
> **Memory**, and hands off to humans when it should.

```
                 AI AGENT PLATFORM
                        │
        ┌───────────────┼────────────────┐
      Voice            Chat          Automation
        └───────────────┼────────────────┘
                  Workflow Runtime
          ┌─────────────┼─────────────┐
         RAG           Tools        Memory
          └─────────────┼─────────────┘
                  Human Handoff
             ┌──────────┼──────────┐
          Ticketing   Customer     CRM
             │          360
          AI Quality
             │
         Analytics / WFM
```

## Deployment shape

A modular monolith with clean domain boundaries and an extractable worker tier. Every
domain is a self-contained NestJS module with its own service, controller, DTOs and
events; nothing crosses a boundary except through a service interface or a domain event.
That keeps the operational surface small enough for private-cloud deployment while
leaving each module extractable into its own service when a tenant's scale demands it.

```
Internet
  ↓
CDN / WAF
  ↓
Load balancer
  ↓
┌───────────────── Kubernetes ──────────────────┐
│  web (Next.js)      api (NestJS/Fastify)      │
│                     realtime gateway (WS)     │
│                     workers (BullMQ)          │
└───────────────────────────────────────────────┘
  ↓
PostgreSQL + pgvector · Redis · Object storage · Search
```

## Runtime processes

| Process | Responsibility |
|---|---|
| `api` | HTTP REST API, OpenAPI, auth, all domain modules |
| `realtime` | WebSocket gateway for agent workspace and chat widget (in-process with `api` by default, separately scalable) |
| `worker` | Queue consumers: ingestion, embeddings, workflow execution, SLA clocks, automation, QC, notifications, webhooks |
| `scheduler` | Repeatable jobs: SLA sweeps, crawls, scheduled reports, retention |

## Service boundaries

| Bounded context | Owns | Key events emitted |
|---|---|---|
| Tenancy | Organization, Workspace, Environment, Subscription | `org.created`, `workspace.created` |
| Identity | User, Membership, Role, Permission, Session, ApiKey | `user.invited`, `role.changed` |
| Audit | AuditEvent | — |
| Directory | Team, Queue, BusinessHours, Holiday, taxonomy | `queue.updated` |
| Customer | Customer, ContactMethod, Attribute, Note, Segment | `customer.created`, `customer.merged` |
| Interaction | Conversation, Message, Participant, Assignment | `conversation.*`, `message.*` |
| Channel | ChannelAdapter registry, inbound/outbound delivery | `channel.inbound`, `channel.delivery` |
| Ticketing | Ticket, Comment, Attachment, Template | `ticket.*` |
| SLA | SlaPolicy, SlaClock, breach evaluation | `sla.warning`, `sla.breached` |
| Routing | RoutingRule, assignment strategies | `routing.assigned` |
| Knowledge | KnowledgeBase, Article, Document, Source | `knowledge.published` |
| RAG | Chunk, Embedding, Retrieval | `rag.indexed` |
| AI Gateway | Provider adapters, model registry, usage | `ai.completion` |
| Agents | Agent, AgentVersion, Workflow, WorkflowVersion | `agent.published` |
| Runtime | Execution, ExecutionStep, state machine | `execution.*` |
| Tools | ToolDefinition, invocation, authorization | `tool.invoked` |
| Memory | MemoryEntry (short/long/agent scope) | — |
| Guardrails | Policy evaluation, PII, injection | `guardrail.triggered` |
| Automation | AutomationRule evaluation | `automation.fired` |
| Quality | QcTemplate, Evaluation, RealtimeSignal | `qc.evaluated`, `qc.alert` |
| Intelligence | Extraction of intent/sentiment/topics/entities | `intel.extracted` |
| Analytics | Aggregations, dashboards, reports | — |
| Notifications | Rules, delivery across channels | `notification.sent` |
| Billing | UsageRecord, plan limits | `usage.recorded` |

## Data strategy

Single PostgreSQL cluster, one logical database, **shared schema with a mandatory
`organizationId` discriminator** on every tenant-owned table. Isolation is enforced in
three layers:

1. **Request context** — an AsyncLocalStorage-backed `TenantContext` resolved by
   middleware from the authenticated principal.
2. **Query layer** — a Prisma client extension injects `organizationId` into every
   `where` clause and rejects any tenant-owned query issued without a tenant context.
3. **Row-level security** — optional Postgres RLS policies for regulated tenants
   (`infra/sql/rls.sql`), keyed on a per-transaction `app.current_org` setting.

Vector data lives in the same cluster via `pgvector`, which keeps retrieval
transactionally consistent with the knowledge that produced it and avoids a second
datastore in private-cloud installs. Redis backs caching, rate limits, presence,
distributed locks and BullMQ queues. Object storage (S3-compatible) holds attachments
and source documents.

## Multi-tenancy

```
User → Organization → Workspace → Resource
```

Every request resolves all four. A **Workspace** is the operational boundary (its own
queues, agents, knowledge and conversations); an **Environment** (`development`,
`staging`, `production`) scopes AI agent versions and integration credentials so agent
changes can be tested before promotion.

Isolation applies to API, database, cache (key prefix `org:{id}:`), search (metadata
filter), files (path prefix `org/{id}/`) and AI (retrieval filter + memory scope).

## Event architecture

Domain events are published transactionally through an **outbox** table and relayed to
Redis Streams by the worker tier. Consumers are idempotent on `eventId`; failures move
to a dead-letter stream after bounded retry. Every event carries the envelope in
[`../events/catalog.md`](../events/catalog.md).

## AI architecture

```
Application → Model Gateway → Provider Adapter → LLM
                   ↓
        usage, cost, latency, fallback, rate limit
```

The gateway is the only component that talks to a provider. It owns model selection,
fallback chains, streaming, retry, token/cost accounting and per-tenant governance
limits. Agents never name a provider — they name a *model role* (`chat`, `fast`,
`reasoning`, `embedding`, `rerank`) that the gateway resolves per tenant.

## Workflow architecture

Workflows are directed graphs of typed nodes, versioned and immutable once published.
The runtime is a durable interpreter: each step transition is persisted before the next
node runs, so an execution survives a process restart and resumes exactly once.
Long waits (human handoff, timers, external callbacks) suspend the execution rather than
holding a worker.

## Search architecture

Hybrid retrieval: pgvector cosine similarity for semantic recall, Postgres full-text
(`tsvector`, `websearch_to_tsquery`) for lexical precision, fused with reciprocal rank
fusion, then reranked. Metadata filters (knowledge base, locale, tags, ACL) are applied
in SQL before fusion so access control can never be bypassed by ranking.

## Voice architecture (designed, Release 2)

```
Telephony → SIP/provider → Voice Gateway → media stream
   → STT (streaming) → Agent Runtime → TTS (streaming) → caller
```
The Voice Gateway terminates media and exposes the same `ChannelAdapter` contract as
text channels, so the AI Voice Agent reuses the identical runtime, RAG, tools and
handoff logic.
