import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a webhook Atrrehub sent you.
 *
 * This is a deliberate second implementation of the platform's signing scheme
 * rather than a shared import: the whole point of a signature is that the
 * receiver checks it independently, and a client that trusted a helper shipped
 * from the same codebase as the sender would be verifying nothing. Both sides
 * are pinned to the same published test vectors, so they cannot drift.
 */

export const SIGNATURE_HEADER = 'x-atrrehub-signature';
export const EVENT_HEADER = 'x-atrrehub-event';
export const DELIVERY_HEADER = 'x-atrrehub-delivery';

/** Matches the sender's window. See the webhooks guide. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface WebhookEvent<T = Record<string, unknown>> {
  id: string;
  type: string;
  createdAt: string;
  organizationId: string;
  data: T;
}

export class WebhookVerificationError extends Error {
  constructor(reason: string) {
    super(`Webhook signature verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
  }
}

export interface VerifyOptions {
  /** Override for tests. Seconds since the epoch. */
  now?: number;
  toleranceSeconds?: number;
}

/**
 * Verify and parse in one step.
 *
 * Takes the **raw request body**, not a parsed object. Re-serializing a parsed
 * body reorders keys and changes whitespace, and the signature is over bytes —
 * this is the single most common reason a first webhook integration fails.
 * Configure your framework to keep the raw body: in Express,
 * `express.json({ verify: (req, _res, buf) => { req.rawBody = buf } })`.
 */
export function constructEvent<T = Record<string, unknown>>(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
  options: VerifyOptions = {},
): WebhookEvent<T> {
  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const result = verifySignature(signatureHeader, secret, payload, options);
  if (!result.valid) throw new WebhookVerificationError(result.reason ?? 'unknown');

  try {
    return JSON.parse(payload) as WebhookEvent<T>;
  } catch {
    throw new WebhookVerificationError('body was signed correctly but is not JSON');
  }
}

export function verifySignature(
  header: string | undefined,
  secret: string,
  payload: string,
  options: VerifyOptions = {},
): { valid: boolean; reason?: string } {
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
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp outside the tolerance window' };
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  if (presented.length !== expected.length) return { valid: false, reason: 'signature mismatch' };
  if (!timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    return { valid: false, reason: 'signature mismatch' };
  }
  return { valid: true };
}
