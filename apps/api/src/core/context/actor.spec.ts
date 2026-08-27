import { describe, expect, it } from 'vitest';
import { actorTypeFor } from './actor';
import type { PrincipalType } from './request-context';

/**
 * These exist because every one of the five call sites did its own partial
 * translation behind a cast, and two principal types had no valid mapping at
 * all — so the insert failed at runtime with nothing failing at build time.
 */
describe('actorTypeFor', () => {
  const ALL: PrincipalType[] = ['user', 'api_key', 'widget', 'system', 'worker'];

  it('maps every principal type to a value the column accepts', () => {
    // The bug in one assertion: `worker` and `widget` used to pass straight
    // through as themselves, and neither is a member of the database enum.
    const allowed = ['user', 'ai_agent', 'system', 'customer'];
    for (const type of ALL) {
      expect(allowed, `${type} maps outside the enum`).toContain(actorTypeFor({ type }));
    }
  });

  it('records a worker as the system, not as a person', () => {
    // Every queued job runs as `worker`. An audit trail that attributes a
    // background job to a user is worse than one that attributes it to the
    // platform, because it is confidently wrong.
    expect(actorTypeFor({ type: 'worker' })).toBe('system');
  });

  it('records the widget as the customer', () => {
    expect(actorTypeFor({ type: 'widget' })).toBe('customer');
  });

  it('keeps an API key attributed to a user', () => {
    // Unchanged behaviour: the key's own id still lands in actorId.
    expect(actorTypeFor({ type: 'api_key' })).toBe('user');
  });

  it('falls back to the system with no principal in scope', () => {
    expect(actorTypeFor(undefined)).toBe('system');
    expect(actorTypeFor(null)).toBe('system');
  });
});
