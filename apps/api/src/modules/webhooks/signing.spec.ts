import { describe, expect, it } from 'vitest';
import {
  TOLERANCE_SECONDS,
  backoffMinutes,
  isValidSubscription,
  matchesEvent,
  newSecret,
  sign,
  signatureHeader,
  verifySignature,
} from './signing';

const SECRET = 'whsec_0123456789abcdef0123456789abcdef';
const PAYLOAD = '{"id":"evt_1","type":"conversation.created"}';
const NOW = 1_770_000_000;

describe('sign', () => {
  it('is stable for the same material', () => {
    expect(sign(SECRET, NOW, PAYLOAD)).toBe(sign(SECRET, NOW, PAYLOAD));
  });

  it('changes with every part of the material', () => {
    const base = sign(SECRET, NOW, PAYLOAD);
    expect(sign(SECRET, NOW + 1, PAYLOAD)).not.toBe(base);
    expect(sign(SECRET, NOW, `${PAYLOAD} `)).not.toBe(base);
    expect(sign(`${SECRET}x`, NOW, PAYLOAD)).not.toBe(base);
  });

  it('produces a hex sha256 digest', () => {
    expect(sign(SECRET, NOW, PAYLOAD)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifySignature', () => {
  const header = signatureHeader(SECRET, NOW, PAYLOAD);

  it('accepts what it signed', () => {
    expect(verifySignature(header, SECRET, PAYLOAD, { now: NOW })).toEqual({ valid: true });
  });

  it('rejects a payload that was altered in transit', () => {
    const tampered = PAYLOAD.replace('conversation.created', 'conversation.deleted');
    expect(verifySignature(header, SECRET, tampered, { now: NOW }).valid).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifySignature(header, `${SECRET}x`, PAYLOAD, { now: NOW }).valid).toBe(false);
  });

  it('rejects a replay once the window has passed, in either direction', () => {
    const late = verifySignature(header, SECRET, PAYLOAD, { now: NOW + TOLERANCE_SECONDS + 1 });
    expect(late).toEqual({ valid: false, reason: 'timestamp outside the tolerance window' });
    // A receiver whose clock is behind must not accept a future-dated capture
    // any more readily than a stale one.
    const early = verifySignature(header, SECRET, PAYLOAD, { now: NOW - TOLERANCE_SECONDS - 1 });
    expect(early.valid).toBe(false);
  });

  it('still accepts at the edge of the window', () => {
    expect(verifySignature(header, SECRET, PAYLOAD, { now: NOW + TOLERANCE_SECONDS }).valid).toBe(
      true,
    );
  });

  it('will not accept a forged timestamp with a real signature', () => {
    // The timestamp is inside the HMAC, so moving it forward to escape the
    // window invalidates the signature rather than extending the replay.
    const forged = `t=${NOW + 10_000},v1=${sign(SECRET, NOW, PAYLOAD)}`;
    const result = verifySignature(forged, SECRET, PAYLOAD, { now: NOW + 10_000 });
    expect(result).toEqual({ valid: false, reason: 'signature mismatch' });
  });

  it('reports a malformed or missing header rather than throwing', () => {
    expect(verifySignature(undefined, SECRET, PAYLOAD).reason).toBe('missing signature header');
    expect(verifySignature('nonsense', SECRET, PAYLOAD).reason).toBe('malformed signature header');
    expect(verifySignature(`t=${NOW}`, SECRET, PAYLOAD, { now: NOW }).reason).toBe(
      'malformed signature header',
    );
    expect(verifySignature(`t=abc,v1=deadbeef`, SECRET, PAYLOAD, { now: NOW }).reason).toBe(
      'malformed signature header',
    );
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on differing lengths; the check must not surface
    // as a 500 on the customer's side or as a crash on ours.
    expect(() => verifySignature(`t=${NOW},v1=ab`, SECRET, PAYLOAD, { now: NOW })).not.toThrow();
    expect(verifySignature(`t=${NOW},v1=ab`, SECRET, PAYLOAD, { now: NOW }).valid).toBe(false);
  });

  it('tolerates whitespace around the header parts', () => {
    const spaced = `t= ${NOW} , v1= ${sign(SECRET, NOW, PAYLOAD)} `;
    expect(verifySignature(spaced, SECRET, PAYLOAD, { now: NOW }).valid).toBe(true);
  });
});

/**
 * The same vectors the SDK asserts against, duplicated deliberately.
 *
 * The sender here and the receiver in `packages/sdk` are independent
 * implementations — a receiver that shared the sender's code would be
 * verifying nothing. These vectors are what keeps them honest: change either
 * side's scheme and this test, or the SDK's, goes red before a customer's
 * integration does.
 */
describe('published test vectors', () => {
  const SECRET_VECTOR = 'whsec_00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  const VECTORS = [
    {
      description: 'an ordinary event payload',
      timestamp: 1_770_000_000,
      payload: '{"id":"evt_1","type":"conversation.created"}',
      v1: 'b81775b98f7efe067f58d30cfc0b72571ac9196713f85ccaaae14e85ecab237b',
    },
    {
      description: 'an empty body',
      timestamp: 1_700_000_000,
      payload: '',
      v1: '023c9219269c5f609ccd78b9ced439f568339d13a7d77b1f2538a6fc24454050',
    },
    {
      description: 'multi-byte characters, which must be hashed as UTF-8 bytes',
      timestamp: 1,
      payload: '{"unicode":"caf\u00e9 \u2615"}',
      v1: 'c54c0aa0c362841685026b7c50988b0d1ec2ee73bd282cc36c4f818345826092',
    },
  ];

  it.each(VECTORS)('signs $description exactly as published', (vector) => {
    expect(sign(SECRET_VECTOR, vector.timestamp, vector.payload)).toBe(vector.v1);
  });
});

describe('newSecret', () => {
  it('is prefixed and unguessable', () => {
    const secret = newSecret();
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(newSecret()).not.toBe(secret);
  });
});

describe('matchesEvent', () => {
  it('matches an exact subscription', () => {
    expect(matchesEvent(['conversation.created'], 'conversation.created')).toBe(true);
    expect(matchesEvent(['conversation.created'], 'conversation.closed')).toBe(false);
  });

  it('matches every event under a prefix, however deep', () => {
    expect(matchesEvent(['conversation.*'], 'conversation.created')).toBe(true);
    expect(matchesEvent(['conversation.*'], 'conversation.status.changed')).toBe(true);
    expect(matchesEvent(['conversation.*'], 'ticket.created')).toBe(false);
  });

  it('does not let a prefix wildcard escape its own segment', () => {
    // The trap: `conversation.*` must not match `conversationsomething.created`
    // just because the string starts the same way.
    expect(matchesEvent(['conversation.*'], 'conversations.created')).toBe(false);
  });

  it('matches everything with a bare star', () => {
    expect(matchesEvent(['*'], 'anything.at.all')).toBe(true);
  });

  it('matches nothing when nothing is subscribed', () => {
    // The default on a half-configured endpoint, and it must never mean "all".
    expect(matchesEvent([], 'conversation.created')).toBe(false);
  });

  it('matches if any one subscription covers the event', () => {
    expect(matchesEvent(['ticket.*', 'conversation.created'], 'conversation.created')).toBe(true);
  });
});

describe('isValidSubscription', () => {
  it('accepts the three supported forms', () => {
    expect(isValidSubscription('*')).toBe(true);
    expect(isValidSubscription('conversation.*')).toBe(true);
    expect(isValidSubscription('conversation.status.changed')).toBe(true);
  });

  it('rejects patterns that can never match', () => {
    expect(isValidSubscription('')).toBe(false);
    expect(isValidSubscription('.*')).toBe(false);
    expect(isValidSubscription('*.created')).toBe(false);
    expect(isValidSubscription('conversation.*.created')).toBe(false);
    expect(isValidSubscription('Conversation.Created')).toBe(false);
    expect(isValidSubscription('conversation created')).toBe(false);
  });
});

describe('backoffMinutes', () => {
  it('grows exponentially and then stops', () => {
    expect(backoffMinutes(1)).toBe(2);
    expect(backoffMinutes(4)).toBe(16);
    expect(backoffMinutes(9)).toBe(512);
    expect(backoffMinutes(10)).toBe(720);
    expect(backoffMinutes(12)).toBe(720);
  });

  it('never returns a delay of zero for a first attempt', () => {
    expect(backoffMinutes(0)).toBe(2);
  });

  it('keeps retrying across a night-long outage', () => {
    const total = Array.from({ length: 12 }, (_, index) => backoffMinutes(index + 1)).reduce(
      (sum, minutes) => sum + minutes,
      0,
    );
    expect(total).toBeGreaterThan(12 * 60);
  });
});
