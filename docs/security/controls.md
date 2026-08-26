# Security controls

## Threat model summary

| Asset | Threat | Control |
|---|---|---|
| Tenant data | Cross-tenant read/write | Tenant context + query-layer enforcement + RLS + isolation tests |
| Credentials | Theft, replay | Argon2id hashing, short-lived JWT, rotating refresh tokens, MFA |
| Sessions | Fixation, hijack | Rotate on privilege change, bind to device fingerprint, revoke-all |
| API | Abuse, enumeration | Per-org and per-principal rate limits, `404` for foreign resources |
| AI | Prompt injection, exfiltration | Guardrail pipeline, tool authorization, retrieval ACL |
| PII | Leakage into logs/models | Structured-log redaction, PII detection + masking before model calls |
| Files | Malicious upload | Type allow-list, size caps, content sniffing, out-of-origin serving |
| Webhooks | Forgery, SSRF | HMAC signatures, timestamp window, egress allow-list, no private CIDRs |
| Secrets | Exposure | Env/secret-manager only, never in DB or logs, rotation policy |
| Supply chain | Dependency compromise | Lockfile, `pnpm audit` in CI, container + image scanning |

## Application controls

- OWASP ASVS L2 as the baseline.
- Helmet security headers, strict CORS allow-list per organization.
- CSRF protection on cookie-authenticated routes (double-submit token); bearer-token
  routes are exempt by construction.
- Input validation on every route via Zod; output serialization strips unknown fields.
- Rate limiting with separate buckets: `auth` (10/min), `api` (600/min), `ai` (60/min),
  `bulk` (10/min).
- Password policy: min 12 chars, breach-list check, Argon2id (m=64MB, t=3, p=4).
- MFA via TOTP with encrypted secrets and single-use recovery codes.
- Account lockout with exponential backoff after repeated failures.

## Data controls

- TLS 1.2+ everywhere; HSTS on public endpoints.
- AES-256 at rest (volume + column-level for tokens, MFA secrets, integration
  credentials) using an envelope key from the secret manager.
- Key rotation: signing keys 90 days, data keys 365 days, both with overlap windows.
- Data masking in logs, exports and AI prompts for flagged PII fields.
- Retention policies per data class, enforced by a scheduled purge job.
- Right-to-erasure: cascading deletion across conversations, messages, memory, vectors,
  attachments and analytics aggregates.

## Infrastructure controls

- Network segmentation; datastores on private subnets with no public endpoint.
- Kubernetes: non-root containers, read-only root filesystem, dropped capabilities,
  seccomp, network policies, pod security admission `restricted`.
- Image scanning and signing in CI; only signed images admitted.
- Secrets from the platform secret manager, mounted as files, never baked into images.

## AI-specific controls

1. **Input guardrails** — prompt-injection heuristics and classifier, jailbreak
   patterns, max input size.
2. **Retrieval guardrails** — every retrieval is filtered by the caller's ACL before
   ranking; citations must resolve to documents the caller may read.
3. **Tool guardrails** — a tool executes only if the agent version declares it, the
   tenant's governance policy allows it, and the invoking principal holds
   `tool:execute`. Egress from custom tools is allow-listed and blocked from private
   address space.
4. **Output guardrails** — PII masking, content policy, schema validation, groundedness
   check against retrieved citations.
5. **Confidence threshold** — below the configured threshold the runtime emits
   `handoff.requested` and routes to a human instead of answering.
6. **Governance** — allowed models, token and cost ceilings, knowledge access scope and
   human-approval requirements are set per organization and enforced in the gateway.

## Audit

Recorded for every login, logout, permission change, user change, configuration change,
agent change, knowledge change and sensitive data access: actor, action, resource,
before/after diff, IP, user agent, request ID, timestamp. Audit records are
append-only and exportable.
