# Atrrehub Documentation

Atrrehub is an AI-native, multi-tenant omnichannel Customer Experience & Contact Center
platform. The AI Agent + Workflow Runtime is the centre of the architecture, not an add-on.

| Area | Contents |
|---|---|
| [product/](./product) | PRD, personas, journeys, feature catalog, MVP boundary |
| [architecture/](./architecture) | Service boundaries, data model, multi-tenancy, events, AI, deployment |
| [api/](./api) | API standards, versioning, errors, pagination, webhooks |
| [events/](./events) | Domain event catalog and contracts |
| [security/](./security) | Threat model, controls, RBAC permission matrix, compliance |
| [ai/](./ai) | Model gateway, RAG, agent runtime, guardrails, evaluation, governance |
| [ux/](./ux) | UX flows and design system |

## Roadmap position

The master plan defines 50 phases. This repository implements the **MVP boundary**
(plan §52) end-to-end, plus a substantial part of Release 2 and the enterprise
foundations. See [product/roadmap.md](./product/roadmap.md) for exactly what is
built, partially built, and deferred.
