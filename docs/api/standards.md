# API standards

## Base

```
https://{host}/api/v1
```

Versioning is by URI prefix. A version is supported for at least 12 months after its
successor ships. Breaking changes require a new version; additive changes do not.

## Authentication

| Scheme | Header | Use |
|---|---|---|
| Bearer access token | `Authorization: Bearer <jwt>` | Interactive clients |
| API key | `X-Api-Key: ak_...` | Server-to-server |
| Widget token | `X-Widget-Token: wt_...` | Public chat widget |

Access tokens are short-lived (15 min) JWTs. Refresh tokens are opaque, rotated on use,
and stored hashed. Tenant scope is embedded in the token and re-verified server-side.

## Tenancy headers

```
X-Organization-Id: org_...    # required when the principal belongs to several orgs
X-Workspace-Id: wks_...       # required for workspace-scoped resources
```
When omitted, the principal's default organization/workspace is used.

## Request conventions

- `Content-Type: application/json` unless uploading multipart.
- `Idempotency-Key` is honoured on all `POST` endpoints that create resources.
- Unknown body properties are rejected (`400`), never silently ignored.
- All input is validated with Zod schemas shared with the SDK.

## Responses

Single resource:
```json
{ "data": { "id": "cus_01H...", "type": "customer", "...": "..." } }
```

Collection:
```json
{
  "data": [ ... ],
  "meta": { "total": 1284, "limit": 25, "cursor": "eyJpZCI6..." },
  "links": { "next": "/api/v1/customers?cursor=eyJpZCI6..." }
}
```

## Pagination

Cursor-based by default (`?limit=25&cursor=...`), stable under concurrent writes.
Offset pagination (`?page=2&perPage=25`) is available on reporting endpoints only.

## Filtering, sorting, sparse fields

```
GET /api/v1/tickets?status=open,pending&priority=critical&sort=-createdAt&fields=id,subject,status
```
Multiple values are comma-separated (OR). Repeated parameters are AND. `sort` accepts a
comma list; `-` prefix means descending.

## Errors

RFC 9457 problem details, always with a stable machine-readable `code`:

```json
{
  "type": "https://docs.atrrehub.com/errors/validation_failed",
  "title": "Validation failed",
  "status": 422,
  "code": "validation_failed",
  "detail": "subject must be at least 3 characters",
  "instance": "/api/v1/tickets",
  "requestId": "req_01H...",
  "errors": [{ "path": "subject", "message": "must be at least 3 characters" }]
}
```

| Status | Code family | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed syntax or unknown field |
| 401 | `unauthenticated` | Missing/invalid credentials |
| 403 | `forbidden`, `permission_denied` | Authenticated but not permitted |
| 404 | `not_found` | Missing, or hidden by tenant scope |
| 409 | `conflict`, `version_conflict` | State or optimistic-lock conflict |
| 422 | `validation_failed` | Semantically invalid input |
| 429 | `rate_limited` | Quota exceeded; `Retry-After` set |
| 451 | `policy_blocked` | Blocked by a guardrail or governance policy |
| 500 | `internal_error` | Unexpected; `requestId` is the support key |
| 503 | `dependency_unavailable` | Upstream (provider/DB) unavailable |

A resource in another tenant returns `404`, never `403` — existence is not disclosed
across tenant boundaries.

## Rate limiting

```
RateLimit-Limit: 600
RateLimit-Remaining: 574
RateLimit-Reset: 41
```
Limits are per organization and per principal, with separate buckets for auth, general
API, AI execution and bulk operations.

## Concurrency

Mutable resources expose `version`. Send `If-Match: "<version>"` on update to get
optimistic locking; a mismatch returns `409 version_conflict`.

## Long-running work

Operations that cannot complete inline return `202 Accepted` with a job handle:
```json
{ "data": { "jobId": "job_...", "status": "queued", "statusUrl": "/api/v1/jobs/job_..." } }
```

## Streaming

AI endpoints support `Accept: text/event-stream` and emit SSE frames:
`delta`, `tool_call`, `citation`, `usage`, `done`, `error`.

## Webhooks

Delivered as `POST` with headers `X-Atrrehub-Event`, `X-Atrrehub-Delivery`,
`X-Atrrehub-Signature: t=<ts>,v1=<hmac-sha256>`. Signatures are computed over
`{timestamp}.{rawBody}`; reject deliveries older than 5 minutes. Retries use exponential
backoff for 24 hours, then the endpoint is disabled and the owner notified.

## Identifiers

Prefixed ULIDs — sortable, opaque, and self-describing in logs: `org_`, `wks_`, `usr_`,
`cus_`, `cnv_`, `msg_`, `tkt_`, `kb_`, `art_`, `doc_`, `agt_`, `wfl_`, `exe_`, `tol_`.

## Deprecation

Deprecated endpoints return `Deprecation: true`, `Sunset: <http-date>` and a `Link` to
migration notes for at least 6 months before removal.
