# Roadmap & delivery status

The plan defines **51 phases (Phase 0 – Phase 50)**, plus two closing sections
that are summaries rather than work: §51 Final Product Structure and §52
Recommended MVP Boundary.

Building all 51 before releasing anything is explicitly discouraged by the plan
(§52), so delivery followed the MVP boundary it defines.

Status is assessed against **code that exists and runs**, not against intent:

- **Built** — implemented, wired into the running application, and exercised.
- **Partial** — the core is implemented and usable; named gaps remain.
- **Schema only** — database tables exist, no service or API behind them.
- **Not built** — designed and documented, no implementation.

**Totals: 38 built · 13 partial · 0 schema only · 0 not built.**

---

## Built (38)

| Phase | Domain | Evidence |
|---|---|---|
| 0 | Product definition & architecture | `docs/` — PRD, architecture, API, events, security, AI, UX |
| 1 | Engineering foundation | Monorepo, config validation, logging, errors, CI, Docker |
| 2 | Multi-tenant platform | Tenant guard extension, provisioning, 11 isolation tests |
| 3 | Identity & access | Auth, MFA, refresh rotation, 66-permission RBAC, audit |
| 4 | Organization administration | Teams, queues, business hours, taxonomy, saved replies |
| 5 | Customer 360 | Profiles, contact normalization, merge, timeline, segments |
| 6 | Interaction & conversation engine | Lifecycle state machine, messages, assignment, transfer |
| 7 | Web chat | Adapter + realtime gateway + embeddable widget |
| 8 | Email | Adapter with RFC 5322 threading and quoted-reply stripping |
| 9 | Agent workspace | Three-column workspace, copilot panel, Customer 360 rail |
| 10 | Ticketing | Case management, history, templates, bulk, optimistic locking |
| 11 | SLA management | Working-time clocks, pause/resume, sweep, escalation |
| 12 | Routing engine | Rules, strategies, capacity, persisted round-robin, drain |
| 13 | Knowledge management | Bases, articles, versioning, publish, ingestion, crawling |
| 14 | RAG platform | Chunking, hybrid search, RRF, rerank, citations, groundedness |
| 15 | AI model gateway | Roles, fallback chains, retry, token/cost accounting, budgets |
| 16 | AI agent builder | Agent config, versioning, 27-node graph model, validation |
| 17 | Workflow runtime | Durable interpreter, suspend/resume, debugger |
| 18 | AI tools platform | 7 built-in tools, custom HTTP tools, egress control |
| 19 | AI memory | Three scopes, PII masking, consent, retention, erasure |
| 20 | AI guardrails | Injection, PII, content policy, groundedness, confidence |
| 21 | AI copilot | Suggest, rewrite, tone, translate, summarize, next action |
| 25 | Automation engine | 11 triggers, conditions, 10 actions, run history, simulate |
| 26 | AI quality management | Weighted scorecards, evidence, disputes, calibration |
| 27 | Real-time quality | Live signals pushed to the agent during the conversation |
| 28 | Customer intelligence | Intent, sentiment, topics, entities, churn risk, trends |
| 24 | AI voice agent | Turn loop over the existing runtime: endpointing, barge-in budget, no-input recovery, handoff with transcript |
| 29 | Analytics platform | Executive, agent, AI and channel dashboards, plus durable daily rollups |
| 31 | Workforce management | Erlang C staffing, seasonal forecasting, rosters, time off, adherence |
| 30 | Reporting | Closed source catalogue, saved reports, CSV export, scheduled email |
| 32 | CRM & enterprise integrations | Connect/test/enable/sync lifecycle, four connectors, field mapping |
| 34 | Notification platform | Rules, audiences, in-app/email/webhook delivery, inbox |
| 36 | AI evaluation | Six scorers, dataset runs, run diffing, the agent promotion gate |
| 38 | Security | Application and data controls — see `docs/security/controls.md` |
| 43 | Disaster recovery | Automated backup, restore verification into a scratch database, readiness endpoint |
| 46 | Hybrid deployment | Control-plane / data-plane split with an enforced data residency guard |
| 48 | Testing platform | 289 unit + 23 integration tests, tenant isolation in CI |
| 49 | Product QA | Requirement→test→security→UAT process, enforced by CI |

---

## Partial (13)

| Phase | Domain | Built | Gap |
|---|---|---|---|
| 22 | Omnichannel expansion | Eight channels: web chat, email, WhatsApp, SMS, Telegram, Messenger, Instagram, Teams — each with webhook signature verification | Teams verification is a shared secret, not the Bot Framework's JWT scheme; no channel has been exercised against a live provider account |
| 23 | Voice platform | Call lifecycle and state machine, IVR engine, call control, recording with consent and retention, routing into the existing engine, three telephony adapters (simulated, Twilio, SIP gateway) | No media plane: audio is carried by the provider, so the platform never touches RTP. Verified end to end against the simulated provider only — no PSTN call has been placed from this repository |
| 33 | Developer platform | API keys with scoped permissions, OpenAPI spec, API request log | No webhook CRUD API, no developer portal, no SDK, no sandbox |
| 35 | Billing & usage | Four plans with ten enforced limits, subscriptions, negotiated overrides, monthly usage records, invoice estimate | No payment provider; the invoice estimate is list price only |
| 37 | AI governance | Allowed models, token and cost limits, retention window, full AI audit trail | No admin API or UI to manage the policy |
| 39 | Enterprise compliance | Retention enforcement, audit trail, right-to-erasure for memory | No data export, no residency controls, no access reviews |
| 40 | Enterprise SSO & provisioning | OIDC with JWKS verification, PKCE, domain routing, JIT provisioning, group→role mapping, SCIM 2.0 Users and Groups | No SAML — assertion signature verification needs XML canonicalization, which is not safe to hand-roll |
| 41 | Observability | 168 Prometheus metrics, structured logs with correlation, OTLP tracing across HTTP and Prisma with database query spans | No log aggregation shipped; no alert rules bundled |
| 42 | High availability | Replicas, HPA, PDB, health probes, graceful shutdown | No read-replica routing, no dead-letter queue configuration |
| 44 | SaaS deployment | Helm chart, Compose, migration hook, ingress, tenant provisioning API with suspend/resume, metered usage records | No payment provider integration |
| 45 | Private cloud / on-prem | Helm values, no-external-dependency local AI provider | No Terraform, no air-gapped packaging, no private registry flow |
| 47 | Performance & scalability | Async processing, caching, partial and HNSW indexes, queue workers | No partitioning, no read replicas, no load-test evidence |
| 50 | Production readiness | Runbooks, monitoring signals, backup and DR procedure | No VAPT, no load testing, no incident-management tooling |

---

## Schema only (0)

Every table in the data model now has code behind it. An audit of all 108
models against the codebase found three that did not — `subscriptions`,
`usage_records` and `metrics_daily` — and all three are now written and read.

---

## Not built (0)

Every phase in the plan now has an implementation. What remains are the named
gaps in the Partial table above, and three things a repository cannot deliver
on its own — a penetration test, a load test against production-like
infrastructure, and a live account with each channel provider.

---

## Release mapping (plan §52)

The plan's MVP boundary is **complete**: multi-tenancy, RBAC, Customer 360,
interaction engine, web chat, email, agent workspace, ticketing, SLA, knowledge
base, RAG, AI agent, visual workflow builder, AI runtime, human handoff, AI
copilot and basic analytics.

| Release | Contents | Status |
|---|---|---|
| **1 — MVP** | Phases 2–21, 29 | Complete |
| **2** | Voice, AI voice, WhatsApp, routing, automation, AI customer context | Routing, automation, customer context, voice and AI voice complete; social outstanding |
| **3** | AI QC, real-time QC, advanced analytics, social channels, WFM | QC, real-time QC and reporting complete; social and WFM outstanding |
| **Enterprise** | SSO, SCIM, private cloud, hybrid, advanced security, AI governance, developer platform, HA/DR | SSO (OIDC), SCIM, security and governance complete; SAML, hybrid and DR outstanding |
