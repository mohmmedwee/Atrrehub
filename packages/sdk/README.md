# @atrrehub/sdk

TypeScript client for the Atrrehub platform API.

```bash
pnpm add @atrrehub/sdk
```

## Calling the API

```ts
import { Atrrehub, AtrrehubError } from '@atrrehub/sdk';

const api = new Atrrehub({
  baseUrl: 'https://api.atrrehub.com',
  apiKey: process.env.ATRREHUB_API_KEY!,
});

const endpoint = await api.createWebhooks({
  name: 'Order system',
  url: 'https://example.com/hooks/atrrehub',
  events: ['conversation.*', 'ticket.created'],
});
```

Every operation is generated from the API's own OpenAPI document, so the method list
matches the deployed API rather than a hand-maintained wrapper that drifts from it.

### Types

Operations return `unknown` by default. The API validates bodies with Zod schemas whose
refinements OpenAPI cannot express, and a generated type that is subtly wrong is worse
than no type at all — so narrowing is yours to do, at the call site:

```ts
interface Endpoint { id: string; url: string; events: string[] }
const endpoints = await api.listWebhooks<Endpoint[]>();
```

### Errors

Failures throw `AtrrehubError`, carrying the RFC 9457 problem document. Branch on `code`,
never on the prose in `detail`:

```ts
try {
  await api.createUsersIam({ email });
} catch (error) {
  if (error instanceof AtrrehubError && error.code === 'quota_exceeded') {
    // out of seats
  }
  throw error;
}
```

`error.requestId` locates the exact request in the platform's logs — quote it in a support
request.

### Retries and idempotency

`GET`, `HEAD` and `DELETE` are retried on 429 and 5xx with jittered backoff. So are
`POST`, `PATCH` and `PUT` — safely, because the client sends an `Idempotency-Key` on every
mutating request, and the server replays the first response rather than performing the
operation twice. Pass your own via `options.idempotencyKey` when the natural key lives in
your system.

## Receiving webhooks

```ts
import express from 'express';
import { constructEvent, WebhookVerificationError } from '@atrrehub/sdk';

app.post('/hooks/atrrehub', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = constructEvent(req.body, req.get('x-atrrehub-signature'), process.env.WEBHOOK_SECRET!);
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.sendStatus(400);
    throw error;
  }
  res.sendStatus(200);  // acknowledge inside 10 seconds
  void handle(event);   // then do the work
});
```

Pass the **raw bytes**. Re-serializing a parsed body changes them, and the signature is
over bytes — this is the most common reason a first integration fails.

Delivery is at-least-once: make your handler idempotent on `event.id`, not on the
`X-Atrrehub-Delivery` header, which is new for every attempt.

The full contract is in [docs/events/webhooks.md](../../docs/events/webhooks.md).

## Regenerating

```bash
pnpm --filter @atrrehub/sdk generate            # against a local API on :4000
pnpm --filter @atrrehub/sdk generate -- --url https://api.example.com
pnpm --filter @atrrehub/sdk generate -- --input openapi.json
```

`src/operations.generated.ts` is committed on purpose: installing the SDK never needs a
running server, and a regeneration shows up as a reviewable diff rather than as a silent
change in behaviour.

Everything else in `src/` is hand-written. Retries, idempotency and error mapping are
decisions rather than descriptions, and generating them would mean regenerating every
judgement each time an endpoint is added.
