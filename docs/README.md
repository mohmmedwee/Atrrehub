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

Documents that stand on their own:

| | |
|---|---|
| [deployment.md](./deployment.md) | Cloud, private-cloud and air-gapped installs; load-test figures |
| [runbooks.md](./runbooks.md) | Day-to-day operations |
| [runbooks-resilience.md](./runbooks-resilience.md) | Dead-lettered jobs, the read replica, partitions |
| [events/webhooks.md](./events/webhooks.md) | The webhook contract, for a customer integrating against it |
| [security/governance.md](./security/governance.md) | AI policy enforcement, subject rights, access reviews |

## Roadmap position

The master plan defines 51 phases, 0 through 50. Forty-two are built and nine
are partial; none are unstarted. See [product/roadmap.md](./product/roadmap.md)
for exactly what is built, what is partial, and what each partial phase is still
missing — and `pnpm audit:docs`, which checks those counts against the code so
this paragraph cannot quietly go out of date.
