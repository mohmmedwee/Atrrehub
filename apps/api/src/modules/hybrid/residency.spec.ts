import { describe, expect, it } from 'vitest';
import { checkResidency, redactForTransit, SHIPPABLE_FIELDS } from './residency';

/**
 * This guard is the entire promise of a hybrid deployment, so the tests are
 * written as attempts to get customer data past it rather than as a
 * demonstration that the happy path works.
 */
const heartbeat = {
  dataPlaneId: 'dp_01',
  region: 'eu-west-1',
  version: '1.4.2',
  status: 'healthy',
  uptimeSeconds: 84_000,
  metrics: { conversations: 1420, messages: 8801, latencyMs: 42, errorRate: 0.001 },
};

describe('a legitimate telemetry payload', () => {
  it('is allowed', () => {
    expect(checkResidency(heartbeat)).toEqual({ allowed: true, violations: [] });
  });

  it('allows aggregate usage per organization', () => {
    const usage = {
      periodStart: '2026-08-01T00:00:00Z',
      periodEnd: '2026-09-01T00:00:00Z',
      items: [
        { organizationId: 'org_01', metric: 'conversations', quantity: 1420, unit: 'count' },
        { organizationId: 'org_02', metric: 'promptTokens', quantity: 991_204, unit: 'tokens' },
      ],
    };
    expect(checkResidency(usage).allowed).toBe(true);
  });
});

describe('customer content is refused', () => {
  it('refuses a message body', () => {
    const result = checkResidency({ ...heartbeat, body: 'My card was declined again' });
    expect(result.allowed).toBe(false);
    expect(result.violations[0]).toMatchObject({ path: 'body', kind: 'undeclared_field' });
  });

  it.each([
    ['subject', 'Refund request'],
    ['customerEmail', 'ada@example.com'],
    ['phoneNumber', '+962790001234'],
    ['displayName', 'Ada Lovelace'],
    ['transcript', 'Caller: hello'],
    ['lastMessageBody', 'anything'],
    ['agentNote', 'internal note'],
    ['aiPrompt', 'You are a helpful assistant'],
    ['recordingUrl', 'https://example.com/rec'],
    ['apiToken', 'sk-live-123'],
  ])('refuses a field named %s', (key, value) => {
    expect(checkResidency({ ...heartbeat, [key]: value }).allowed).toBe(false);
  });

  it('refuses a field nobody declared, even one that looks harmless', () => {
    const result = checkResidency({ ...heartbeat, favouriteColour: 'blue' });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].detail).toContain('not declared shippable');
  });

  it('refuses content buried deep inside a declared field', () => {
    const result = checkResidency({
      ...heartbeat,
      metrics: { conversations: 1, items: [{ data: { body: 'hidden' } }] },
    });
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.path.includes('body'))).toBe(true);
  });
});

describe('PII inside a declared field', () => {
  it('catches an email address smuggled into a status', () => {
    const result = checkResidency({ ...heartbeat, status: 'failing for ada@example.com' });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].kind).toBe('pii_detected');
  });

  it('catches a phone number in an error string', () => {
    const result = checkResidency({ ...heartbeat, lastError: 'could not reach +962 79 000 1234' });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].kind).toBe('pii_detected');
  });

  it('catches a card number', () => {
    const result = checkResidency({ ...heartbeat, lastError: 'declined 4111111111111111' });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].kind).toBe('pii_detected');
  });
});

describe('prose in a declared field', () => {
  it('refuses a sentence where a label belongs', () => {
    const result = checkResidency({
      ...heartbeat,
      lastError: 'The customer called about a refund and was extremely unhappy with the outcome',
    });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].kind).toBe('free_text');
  });

  it('refuses a very long string even without spaces', () => {
    const result = checkResidency({ ...heartbeat, lastError: 'x'.repeat(500) });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].kind).toBe('free_text');
  });

  it('allows a short error code', () => {
    expect(checkResidency({ ...heartbeat, lastError: 'ECONNREFUSED' }).allowed).toBe(true);
  });
});

describe('structural limits', () => {
  it('refuses a payload nested to hide things', () => {
    let nested: Record<string, unknown> = { count: 1 };
    for (let i = 0; i < 10; i += 1) nested = { data: nested };
    expect(checkResidency(nested).allowed).toBe(false);
  });

  it('refuses a payload too large to be telemetry', () => {
    const result = checkResidency({
      metrics: Array.from({ length: 20_000 }, () => ({ metric: 'conversations', value: 1 })),
    });
    expect(result.violations.some((v) => v.kind === 'too_large')).toBe(true);
  });

  it('reports every violation, not just the first', () => {
    const result = checkResidency({ body: 'x', subject: 'y', customerEmail: 'z' });
    expect(result.violations.length).toBe(3);
  });
});

describe('the allow-list itself', () => {
  it('contains nothing that names customer content', () => {
    const suspicious = [...SHIPPABLE_FIELDS].filter((field) =>
      /body|subject|content|transcript|email|phone|name|address|password|secret/i.test(field),
    );
    expect(suspicious).toEqual([]);
  });
});

describe('redactForTransit', () => {
  it('leaves a clean payload untouched', () => {
    expect(redactForTransit(heartbeat)).toEqual(heartbeat);
  });

  it('drops the offending field and keeps the rest', () => {
    const redacted = redactForTransit({ ...heartbeat, body: 'secret' }) as Record<string, unknown>;
    expect(redacted.body).toBeUndefined();
    expect(redacted.dataPlaneId).toBe('dp_01');
    expect(redacted.metrics).toEqual(heartbeat.metrics);
  });

  it('drops a declared field whose value carries PII', () => {
    const redacted = redactForTransit({
      ...heartbeat,
      lastError: 'failed for ada@example.com',
    }) as Record<string, unknown>;
    expect(redacted.lastError).toBeUndefined();
  });

  it('produces something that passes the guard it was redacted for', () => {
    const dirty = { ...heartbeat, body: 'x', customerEmail: 'ada@example.com', note: 'hello' };
    expect(checkResidency(redactForTransit(dirty)).allowed).toBe(true);
  });
});
