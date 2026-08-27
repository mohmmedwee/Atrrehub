# Webhooks

Every domain event the platform publishes can be delivered to an HTTPS endpoint you
control. The event catalogue is in [catalog.md](catalog.md), and
`GET /api/v1/webhooks/events` returns the same list at runtime.

## Registering an endpoint

```http
POST /api/v1/webhooks
{
  "name": "Order system",
  "url": "https://example.com/hooks/atrrehub",
  "events": ["conversation.*", "ticket.created"]
}
```

The response carries the signing secret. **It is returned exactly once.** It is stored
encrypted and no endpoint gives it back; if you lose it, rotate it
(`POST /api/v1/webhooks/{id}/rotate-secret`) and deploy the new one.

### Subscriptions

Three forms, and deliberately no more:

| Form | Matches |
|---|---|
| `conversation.created` | that event only |
| `conversation.*` | every event under the `conversation.` prefix, however deep |
| `*` | everything |

Mid-pattern wildcards (`conversation.*.changed`) are rejected: they look powerful and
make "which of my customers' data does this endpoint receive" impossible to answer.

An empty subscription list is rejected too. Silence must never mean "send everything".

## What you receive

```http
POST /hooks/atrrehub
Content-Type: application/json
User-Agent: Atrrehub-Webhooks/1.0
X-Atrrehub-Event: conversation.created
X-Atrrehub-Delivery: dlv_01J8XK...
X-Atrrehub-Signature: t=1770000000,v1=b81775b98f7efe06...

{
  "id": "evt_01J8XK...",
  "type": "conversation.created",
  "createdAt": "2026-03-01T09:15:04.221Z",
  "organizationId": "org_01J8XK...",
  "data": { "conversationId": "cnv_01J8XK..." }
}
```

Respond with any 2xx. Anything else — or no response within 10 seconds — counts as a
failure. Respond first and do your work afterwards: the 10-second timeout is a delivery
deadline, not a processing budget.

## Verifying the signature

The signature is `HMAC-SHA256(secret, "{timestamp}.{rawBody}")`, hex-encoded. The
timestamp is *inside* the signed material, so it cannot be moved forward to escape the
replay window without invalidating the signature.

Reject a delivery whose timestamp is more than **300 seconds** from your own clock, in
either direction.

Verify against the **raw request bytes**. Parsing the body and re-serializing it changes
whitespace and can reorder keys; the signature is over bytes, and this is the single most
common reason a first integration fails.

```ts
import express from 'express';
import { constructEvent } from '@atrrehub/sdk';

const app = express();
app.post(
  '/hooks/atrrehub',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    let event;
    try {
      event = constructEvent(req.body, req.get('x-atrrehub-signature'), process.env.WEBHOOK_SECRET!);
    } catch {
      return res.sendStatus(400);
    }
    res.sendStatus(200);   // acknowledge first
    void handle(event);    // then do the work
  },
);
```

Writing a receiver in another language? Use the published test vectors in
`packages/sdk/src/vectors.ts` — the platform and the SDK both assert against them, so a
third implementation that matches them will interoperate with both.

## Delivery, retries and failure

Deliveries are recorded before the first request is made, so a process that dies
mid-fan-out leaves work the retry sweep finishes rather than events that silently went
nowhere.

A failed delivery is retried with exponential backoff — 2 minutes, then 4, 8, 16 … capped
at 12 hours — for 12 attempts, roughly two days in total. That is deliberately long
enough to survive an overnight outage.

After **15 consecutive failures** across all deliveries, the endpoint is deactivated and
the organization's owners and administrators are notified. It is never deleted: your
delivery history is preserved, and re-enabling it (`PATCH` with `isActive: true`) clears
the failure count and restores the full retry budget.

### Delivery is at-least-once

An endpoint that accepts a delivery but whose acknowledgement is lost will see that event
again. **Make your handler idempotent**, keyed on the `id` field of the payload — not on
the `X-Atrrehub-Delivery` header, which is a new value for each attempt and for each
replay.

## Inspecting and replaying

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/webhooks/deliveries` | recent attempts; filter by `endpointId` and `status` |
| `GET /api/v1/webhooks/deliveries/{id}` | one delivery, including the payload sent |
| `POST /api/v1/webhooks/deliveries/{id}/replay` | send the same event again |
| `POST /api/v1/webhooks/{id}/ping` | a synthetic event, to prove the endpoint works |

A replay creates a *new* delivery rather than resetting the old one — the record of what
was attempted and when is the reason the history exists.

A ping is not recorded as a delivery and does not count toward the failure budget: a test
against a deliberately-down endpoint should not retire it.

## Ordering

Events are **not** ordered. Two events produced milliseconds apart may arrive in either
order, and a retried event will arrive after events that came later. Use the `createdAt`
field and the state in your own system rather than assuming arrival order.

## Local development

Outside production the platform will deliver to `http://localhost:…`, so you can point an
endpoint at a receiver on your own machine. In production the URL must be HTTPS and must
not resolve to private address space — a webhook URL is tenant-supplied, and that rule is
what stops one being used to probe the cluster the platform runs in.
