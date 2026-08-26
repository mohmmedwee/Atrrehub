# Product Requirements Document — Atrrehub

## 1. Objective

Build a multi-tenant SaaS / private-cloud / hybrid AI-Native Customer Experience and
Contact Center Platform with feature parity against established omnichannel desks, where
the AI Agent, workflow, RAG, voice, automation and AI-QC layers are **first-class
platform capabilities** rather than bolt-ons.

## 2. Capability statement

The platform enables an organization to:

1. Manage customers as a unified identity (Customer 360).
2. Receive interactions from multiple channels (chat, email, voice, social).
3. Route interactions to the correct team/agent by skill, language, priority, intent.
4. Let humans handle conversations in a purpose-built workspace.
5. Let AI agents handle conversations autonomously.
6. Build AI agents visually, without code.
7. Connect agents to enterprise APIs and tools.
8. Ground agents in enterprise knowledge (RAG) with citations.
9. Transfer conversations between AI and humans in both directions.
10. Manage tickets and SLAs with business-hours-aware clocks.
11. Monitor customer sentiment and intent continuously.
12. Assist human agents with an AI copilot.
13. Automatically evaluate agent and AI quality (AI-QC).
14. Manage workforce (forecasting, scheduling, adherence).
15. Analyze operations across every dimension.
16. Integrate with external systems (CRM, business systems, webhooks).
17. Deploy securely at enterprise scale (SaaS, private cloud, hybrid).

## 3. Personas

| Persona | Goal | Primary surfaces |
|---|---|---|
| **Customer** | Get an answer fast, in their language, on their channel | Web chat widget, email, voice, social |
| **Agent** | Resolve conversations efficiently with full context | Agent Workspace, AI Copilot |
| **Supervisor** | Keep queues healthy, SLAs green, agents supported | Live queue monitor, real-time QC alerts, analytics |
| **QA Manager** | Ensure consistent quality and compliance | AI-QC scorecards, calibration, disputes |
| **AI Builder** | Ship and improve AI agents safely | Agent Builder, workflow canvas, evaluation suite |
| **Administrator** | Configure the organization and control access | Admin console, RBAC, SSO, business hours |
| **Analyst** | Understand operations and cost | Dashboards, custom reports, exports |
| **Developer** | Extend the platform | Developer portal, API keys, webhooks, custom tools |
| **Organization Owner** | Own commercial and governance posture | Billing, usage, AI governance, audit |

## 4. Functional requirements (MVP)

### FR-1 Multi-tenancy
Every request resolves `User → Organization → Workspace → Resource`. No tenant may read
or write another tenant's data via API, database, cache, search, files or AI context.

### FR-2 Identity & access
Email/password auth, email verification, password reset, session management, TOTP MFA,
refresh-token rotation, API keys, and role-based access control with fine-grained
per-module permissions. Every security-relevant action is audited.

### FR-3 Customer 360
Create, search, merge and segment customers. Unified timeline across conversations,
tickets, calls, emails and activities. Custom attributes, tags, notes, external IDs, and
an AI-generated customer context (summary, intent, sentiment, topics, risk).

### FR-4 Interaction engine
Conversations move `NEW → QUEUED → ASSIGNED → ACTIVE → WAITING → RESOLVED → CLOSED`.
Messages, attachments, participants, internal notes, priority, tags, transfer,
reassignment and full history.

### FR-5 Channels
Web chat (widget + realtime), email (inbound/outbound, threading, templates,
signatures, email-to-ticket). All channels implement one `ChannelAdapter` interface so
channel specifics never leak into the core.

### FR-6 Agent workspace
Inbox, queue view, conversation view, customer view, ticket view, internal notes, saved
responses, search, filters, transfer, escalation and agent presence/status.

### FR-7 Ticketing
Full case management with status, priority, category, SLA, labels, custom fields,
comments, attachments, templates, bulk operations and history.

### FR-8 SLA
First-response, resolution and waiting targets per priority/team, evaluated against
business hours and holidays, with warning thresholds, breach events and escalation.

### FR-9 Knowledge & RAG
Knowledge bases, categories, articles and documents with draft/publish, versioning and
permissions. Ingestion pipeline: parse → clean → chunk → embed → index. Retrieval:
hybrid vector + keyword search, metadata filters, reranking, citations and source
attribution, respecting access control.

### FR-10 AI agents
Configure an agent (instructions, model, temperature, knowledge, tools, memory,
guardrails, handoff rules). Compose behaviour on a visual canvas with trigger, AI,
knowledge, logic, action and human nodes. Execute on a durable runtime with retries,
timeouts, cancellation, versioning, idempotency and a full execution debugger showing
inputs, outputs, node duration, LLM calls, tool calls, tokens and cost.

### FR-11 AI safety
Prompt-injection detection, sensitive-data detection, PII masking, output validation,
tool authorization, content policies, confidence thresholds and automatic human
escalation below threshold.

### FR-12 AI copilot
Suggested response, rewrite, summarize, translate, tone adjustment, knowledge
suggestion, next-best action, customer summary, intent and sentiment.

### FR-13 Analytics
Executive, agent, AI and channel dashboards; interaction volume, resolution rate, AI
resolution rate, CSAT, SLA attainment, AHT, FCR, QA score, handoff rate, token and cost.

## 5. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | API latency (p95, read) | < 300 ms |
| NFR-2 | API latency (p95, write) | < 600 ms |
| NFR-3 | Realtime message delivery (p95) | < 500 ms |
| NFR-4 | RAG retrieval (p95) | < 800 ms |
| NFR-5 | Voice round trip (p95) | < 1200 ms |
| NFR-6 | Availability | 99.9% (SaaS), 99.5% (private) |
| NFR-7 | RPO / RTO | 5 min / 60 min (enterprise tier) |
| NFR-8 | Concurrency | thousands of concurrent agents, millions of conversations |
| NFR-9 | Tenant isolation | enforced at query layer, verified by automated tests |
| NFR-10 | Encryption | TLS 1.2+ in transit, AES-256 at rest |
| NFR-11 | Auditability | every config/permission/data-access change recorded |
| NFR-12 | Observability | logs, metrics, traces and events from every service |
| NFR-13 | Portability | same artifacts run in SaaS, private cloud and hybrid |

## 6. Out of scope for MVP

Voice/telephony, social channels, WFM, SCIM, air-gapped packaging and certification
programmes are scheduled in later releases — see [roadmap.md](./roadmap.md).

## 7. Definition of Done (per feature)

`Requirement → Implementation → Unit tests → Integration tests → E2E → Security review →
Performance check → UAT → Production`.
