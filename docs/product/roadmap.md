# Roadmap & delivery status

The master plan defines 50 phases. Building all 50 before releasing anything is
explicitly discouraged by the plan (§52), so delivery follows the MVP boundary.

Legend: **Built** = implemented in this repository · **Partial** = core implemented,
depth deferred · **Planned** = designed, not implemented.

## Release 1 — MVP boundary (plan §52)

| Phase | Domain | Status |
|---|---|---|
| 0 | Product definition & architecture | Built (`/docs`) |
| 1 | Engineering foundation | Built |
| 2 | Multi-tenant platform | Built |
| 3 | Identity & access management | Built |
| 4 | Organization administration | Built |
| 5 | Customer 360 | Built |
| 6 | Interaction & conversation engine | Built |
| 7 | Web chat | Built |
| 8 | Email | Built |
| 9 | Agent workspace | Built |
| 10 | Ticketing | Built |
| 11 | SLA management | Built |
| 12 | Routing engine | Built |
| 13 | Knowledge management | Built |
| 14 | RAG platform | Built |
| 15 | AI model gateway | Built |
| 16 | AI agent builder | Built |
| 17 | Workflow runtime | Built |
| 18 | AI tools platform | Built |
| 19 | AI memory | Built |
| 20 | AI guardrails | Built |
| 21 | AI copilot | Built |
| 29 | Analytics platform (basic) | Built |

## Release 2

| Phase | Domain | Status |
|---|---|---|
| 22 | Omnichannel expansion (WhatsApp, SMS, Telegram, Messenger, Instagram, Teams) | Partial — adapter interface + registry built, provider adapters stubbed |
| 23 | Voice platform | Planned — architecture documented |
| 24 | AI voice agent | Planned — architecture documented |
| 25 | Automation engine | Built |
| 28 | Customer intelligence | Built |

## Release 3

| Phase | Domain | Status |
|---|---|---|
| 26 | AI quality management | Built |
| 27 | Real-time quality | Built |
| 29 | Advanced analytics | Partial |
| 30 | Reporting | Partial — saved reports + CSV export |
| 31 | Workforce management | Planned |

## Enterprise

| Phase | Domain | Status |
|---|---|---|
| 32 | CRM & enterprise integrations | Partial — generic REST/webhook/OAuth framework |
| 33 | Developer platform | Partial — API keys, webhooks, OpenAPI, API logs |
| 34 | Notification platform | Built |
| 35 | Billing & usage | Partial — usage metering + plan limits |
| 36 | AI evaluation | Built |
| 37 | AI governance | Built |
| 38 | Security | Built |
| 39 | Enterprise compliance | Partial — retention, deletion, export, audit |
| 40 | Enterprise SSO & provisioning | Partial — OIDC/SAML hooks, SCIM planned |
| 41 | Observability | Built |
| 42 | High availability | Partial — replicas, health, autoscaling manifests |
| 43 | Disaster recovery | Partial — backup/DR runbooks |
| 44 | SaaS deployment | Built (Helm + compose) |
| 45 | Private cloud / on-prem | Partial — Helm values + Terraform skeleton |
| 46 | Hybrid deployment | Planned — control/data plane split documented |
| 47 | Performance & scalability | Partial |
| 48 | Testing platform | Built |
| 49 | Product QA | Built (process) |
| 50 | Production readiness | Partial — runbooks |
