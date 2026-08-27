import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing and subscription matching.
 *
 * Pure and infrastructure-free so the exact bytes a customer's server will
 * verify can be asserted in tests — a signature scheme that is only exercised
 * against a live endpoint is a scheme nobody can debug.
 */

export const SIGNATURE_HEADER = 'x-atrrehub-signature';
export const EVENT_HEADER = 'x-atrrehub-event';
export const DELIVERY_HEADER = 'x-atrrehub-delivery';

/**
 * How far a signature's timestamp may be from the receiver's clock.
 *
 * The timestamp is inside the signed material, so an attacker cannot alter it
 * without invalidating the signature; the window is what stops a captured
 * request from being replayed indefinitely. Five minutes is the same tolerance
 * Stripe and GitHub use, and it survives ordinary clock drift.
 */
export const TOLERANCE_SECONDS = 300;

/** A prefix makes a leaked secret recognisable in a log or a paste. */
export function newSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

/**
 * The signed material is `${timestamp}.${payload}`.
 *
 * The timestamp is folded into the HMAC rather than sent alongside it because a
 * timestamp outside the signature is a field the attacker controls, and a
 * receiver that trusts it has no replay protection at all.
 */
export function sign(secret: string, timestamp: number, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

export function signatureHeader(secret: string, timestamp: number, payload: string): string {
  return `t=${timestamp},v1=${sign(secret, timestamp, payload)}`;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify a header the platform produced. Shipped in the SDK, and used by the
 * platform's own tests, so that what customers run is what is tested here.
 */
export function verifySignature(
  header: string | undefined,
  secret: string,
  payload: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): VerificationResult {
  if (!header) return { valid: false, reason: 'missing signature header' };

  const parts = new Map<string, string>();
  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');
    if (index > 0) parts.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim());
  }

  const timestamp = Number(parts.get('t'));
  const presented = parts.get('v1');
  if (!Number.isFinite(timestamp) || !presented) {
    return { valid: false, reason: 'malformed signature header' };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp outside the tolerance window' };
  }

  const expected = sign(secret, timestamp, payload);
  // Compared over bytes of equal length: timingSafeEqual throws on a length
  // mismatch, which would itself leak the length through the error path.
  if (presented.length !== expected.length) return { valid: false, reason: 'signature mismatch' };
  if (!timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    return { valid: false, reason: 'signature mismatch' };
  }
  return { valid: true };
}

/**
 * Whether an endpoint's subscriptions cover an event type.
 *
 * Three forms, and deliberately no more: `*` for everything, `conversation.*`
 * for every event under a prefix, and the exact type. Mid-pattern wildcards
 * look powerful and are impossible to reason about when the question being
 * asked is "which of my customers' data does this endpoint receive".
 *
 * An empty subscription list matches nothing. The opposite default — silence
 * meaning "send everything" — turns a half-finished endpoint into a data leak.
 */
export function matchesEvent(subscriptions: readonly string[], type: string): boolean {
  for (const subscription of subscriptions) {
    if (subscription === '*') return true;
    if (subscription === type) return true;
    if (subscription.endsWith('.*') && type.startsWith(subscription.slice(0, -1))) return true;
  }
  return false;
}

/** Reject a subscription that can never match, at the point it is configured. */
export function isValidSubscription(subscription: string): boolean {
  if (subscription === '*') return true;
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$/.test(subscription)) return false;
  // A wildcard needs something to be a wildcard *of*.
  return subscription !== '.*';
}

/**
 * Exponential backoff, capped so a customer's overnight outage is still being
 * retried in the morning: attempt 1 waits 2 minutes, attempt 12 waits 12 hours.
 */
export function backoffMinutes(attempt: number): number {
  return Math.min(2 ** Math.max(1, attempt), 720);
}
