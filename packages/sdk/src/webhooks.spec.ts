import { describe, expect, it } from 'vitest';
import { SIGNING_TEST_VECTORS } from './vectors.js';
import { WebhookVerificationError, constructEvent, verifySignature } from './webhooks.js';

const { secret, cases } = SIGNING_TEST_VECTORS;

describe('verifySignature', () => {
  it.each(cases)('accepts the published vector for $description', (vector) => {
    const header = `t=${vector.timestamp},v1=${vector.v1}`;
    const result = verifySignature(header, secret, vector.payload, {
      now: vector.timestamp,
      // The vectors use fixed timestamps, several of them long past; the
      // window is exercised separately below.
      toleranceSeconds: 0,
    });
    expect(result).toEqual({ valid: true });
  });

  it('rejects a payload that changed after signing', () => {
    const [vector] = cases;
    const header = `t=${vector.timestamp},v1=${vector.v1}`;
    const result = verifySignature(header, secret, `${vector.payload} `, {
      now: vector.timestamp,
      toleranceSeconds: 0,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a stale capture and one from the future alike', () => {
    const [vector] = cases;
    const header = `t=${vector.timestamp},v1=${vector.v1}`;
    expect(
      verifySignature(header, secret, vector.payload, { now: vector.timestamp + 301 }).reason,
    ).toBe('timestamp outside the tolerance window');
    expect(
      verifySignature(header, secret, vector.payload, { now: vector.timestamp - 301 }).valid,
    ).toBe(false);
  });

  it('never throws on a header an attacker controls', () => {
    for (const header of ['', 'x', 't=,v1=', 't=1,v1=', `t=1,v1=${'z'.repeat(64)}`, 'v1=abc']) {
      expect(() => verifySignature(header, secret, 'body')).not.toThrow();
      expect(verifySignature(header, secret, 'body').valid).toBe(false);
    }
  });
});

describe('constructEvent', () => {
  const timestamp = cases[0].timestamp;
  const header = `t=${timestamp},v1=${cases[0].v1}`;

  it('returns the parsed event once the signature checks out', () => {
    const event = constructEvent(cases[0].payload, header, secret, {
      now: timestamp,
      toleranceSeconds: 0,
    });
    expect(event).toEqual({ id: 'evt_1', type: 'conversation.created' });
  });

  it('accepts a Buffer, which is what a raw-body middleware hands you', () => {
    const event = constructEvent(Buffer.from(cases[0].payload, 'utf8'), header, secret, {
      now: timestamp,
      toleranceSeconds: 0,
    });
    expect(event.id).toBe('evt_1');
  });

  it('throws rather than returning an unverified event', () => {
    expect(() => constructEvent(cases[0].payload, 'bogus', secret, { now: timestamp })).toThrow(
      WebhookVerificationError,
    );
    expect(() => constructEvent(cases[0].payload, undefined, secret, { now: timestamp })).toThrow(
      WebhookVerificationError,
    );
  });

  it('rejects a re-serialized body, which is the usual first-integration mistake', () => {
    // Same object, different bytes: JSON.stringify of a parsed body reorders
    // nothing here but changes spacing, and the signature is over bytes.
    const reserialized = JSON.stringify(JSON.parse(cases[0].payload), null, 2);
    expect(() =>
      constructEvent(reserialized, header, secret, { now: timestamp, toleranceSeconds: 0 }),
    ).toThrow(WebhookVerificationError);
  });
});
