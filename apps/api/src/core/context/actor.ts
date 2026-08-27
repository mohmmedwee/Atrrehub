import type { ActorType } from '@prisma/client';
import type { PrincipalType } from './request-context';

/**
 * Map who is acting onto the database's `ActorType`.
 *
 * These are two different vocabularies and always were. A principal can be a
 * `worker` or a `widget`; the column accepts neither. Every call site used to
 * do its own partial translation — handling `api_key` and letting everything
 * else fall through — behind an `as any`, so the compiler said nothing and the
 * insert failed at runtime instead.
 *
 * The consequence was not cosmetic: `QueueService.register` runs every job
 * with `principal.type === 'worker'`, so *any* domain event published from a
 * queue consumer failed to write, and so did its audit record.
 *
 * Declared as a total `Record`, so adding a principal type will not compile
 * until somebody decides what it means here.
 */
const ACTOR_BY_PRINCIPAL: Record<PrincipalType, ActorType> = {
  user: 'user',
  // An API key acts on behalf of the person or system that created it, and the
  // key's own id is recorded separately in `actorId`.
  api_key: 'user',
  // The widget is the customer — that is the whole point of it.
  widget: 'customer',
  system: 'system',
  // A worker is the platform acting on its own behalf. Not `user`: nobody
  // clicked anything, and an audit trail that says a person did is worse than
  // one that says the system did.
  worker: 'system',
};

/** The actor for the principal in scope, defaulting to the platform itself. */
export function actorTypeFor(principal?: { type: PrincipalType } | null): ActorType {
  if (!principal) return 'system';
  return ACTOR_BY_PRINCIPAL[principal.type] ?? 'system';
}
