# Governance and data subject rights

## AI governance policy

One policy per organization, at `GET`/`PUT /api/v1/governance/policy`. Every field is
enforced somewhere; none of them are advisory.

| Field | Enforced by | Effect |
|---|---|---|
| `allowedProviders` | AI gateway routing chain | Providers not listed are dropped from the chain |
| `allowedModels` | AI gateway routing chain | Models not listed are dropped from the chain |
| `allowedTools` | Tool runner | An invocation of an unlisted tool is refused |
| `monthlyTokenLimit` | AI gateway, before each call | The call is refused once the month's total is reached |
| `monthlyCostLimitUsd` | AI gateway, before each call | As above, in dollars |
| `perExecutionTokenCap` | Workflow runtime, after each step | The execution fails rather than continuing |
| `dataRetentionDays` | Nightly retention sweep | Conversations older than the window are deleted |
| `requireHumanApproval` | Agent publication | The person publishing must not be the one who wrote the draft |

`allowTraining` is the one field that enforces nothing here, and deliberately: this
platform has no training pipeline to gate. It is a recorded instruction to whoever
operates the deployment, and to any provider integration that later honours it. It is
listed separately rather than in the table above so that nobody reads it as a control.

### Four-eyes on publication

With `requireHumanApproval` set, publishing an agent version is refused when the publisher
is the person who wrote the draft, or when the request has no user behind it (an API key
or a system job). A draft written before the author was recorded is allowed through — the
policy is about the next change, and refusing would strand every agent that predates it.

### The empty list means "no restriction"

`allowedProviders`, `allowedModels` and `allowedTools` start empty on every organization,
and an empty list permits everything. Reading it as "nothing is permitted" would have
stopped every AI call in the platform the day the enforcement shipped.

The consequence worth knowing: **an organization that has never opened this screen has no
model or tool restrictions**. Setting one is an explicit act.

### Caching

All three enforcement points read the policy through a single Redis key with a five-minute
TTL, and `PUT /governance/policy` deletes that key. A change therefore takes effect on the
next call rather than up to five minutes later — which matters, because the moment somebody
forbids a provider is usually the moment something is going wrong with it.

### Validation

- Retention must be between 7 and 3650 days. Below a week cannot be honoured accurately by
  a nightly sweep, so promising it would be a lie.
- A provider that is not configured on the deployment is rejected. Allowing one is not
  dangerous, but it produces a policy that looks permissive and blocks everything.
- A per-execution cap above the monthly limit is rejected: it can never bind, and it hides
  that the monthly limit is what actually stops you.

## Data subject rights

### Access — `POST /governance/subjects/{customerId}/export`

Writes a JSON archive to object storage containing the customer record, contact methods,
notes, activities, AI context, conversations, **every message in those conversations**
(agent replies included — they are part of the subject's record), tickets, calls and AI
memory.

One archive per customer, at a deterministic key, overwritten on each export. A fresh key
each time would accumulate complete copies of a person's data that nothing tracks and
erasure cannot find.

### Erasure — `POST /governance/subjects/{customerId}/erase`

Pass `?dryRun=true` to see what would go without touching anything.

**What this replaced matters.** `DELETE /customers/{id}` sets `conversations.customer_id`
and `tickets.customer_id` to NULL — every message body, subject line and voice recording
stayed in the database and became unreachable. That is worse than not erasing, because it
looks like erasing. It is still the wrong endpoint for an erasure request; this one is
right.

The plan is in `apps/api/src/modules/governance/erasure-plan.ts`, as data rather than
procedural code, so that "what happens to their messages" is a table somebody can read and
hand to a regulator.

Rows are **redacted** where they carry meaning of their own and **deleted** where they
exist only because the person did:

| Deleted outright | Redacted, row survives |
|---|---|
| memory entries, AI context, notes, activities, contact methods, attachments and their files, call recordings and their files, the customer row | messages, participants, call events, calls, conversations, tickets |

Deleting every conversation a person ever had would take the agent's replies, the SLA
record, the quality evaluations and the volume statistics with it — none of which are the
person's personal data, and some of which the business is separately required to keep.
Erasure removes the person from the record; it does not rewrite the history of the
business.

Redacted content is replaced with a visible tombstone rather than a blank, because a blank
message body is indistinguishable from a bug.

The customer row is erased **last**: it is the only way to find most of the rest, and a
plan that removed it first would strand the transcripts. A unit test asserts this ordering.

Any export archive for that customer is deleted too. Erasing the database while a complete
archive survives in object storage is not erasure, and it is the copy most likely to be
forgotten because nothing in the database points at it.

The audit record survives, and must: proving an erasure happened is itself a compliance
obligation, and it contains no personal data beyond an identifier that now refers to
nothing.

## Access review — `GET`/`POST /governance/access-review`

Who can do what today, for the review an auditor asks for. The permission matrix says what
each *role* may do; this says what actual named people can do, and the two diverge the
moment somebody is given a custom role.

Each member is reported with their role, last sign-in, dormancy (60 days, or never signed
in), live sessions, live API keys, and which sensitive permissions they hold — with a
one-line reason each, such as "can mint credentials that outlive their account".

Rows carrying a flag are listed first:

- dormant account with sensitive access
- sensitive access without MFA
- owner whose account is not active
- dormant account with live API keys

`POST` records that a review happened, with the decision and a snapshot of what was
flagged. It goes to the audit trail rather than a table of its own: the audit trail is
already append-only, already retained, and already the thing an auditor is handed.
