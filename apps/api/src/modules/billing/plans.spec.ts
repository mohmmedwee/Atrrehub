import { describe, expect, it } from 'vitest';
import { LIMIT_LABELS, PLANS, effectiveLimit, hasFeature, type LimitKey } from './plans';

const TIERS = ['starter', 'professional', 'business', 'enterprise'] as const;

describe('PLANS', () => {
  it('labels every limit key', () => {
    for (const key of Object.keys(PLANS.starter.limits) as LimitKey[]) {
      expect(LIMIT_LABELS[key]).toBeTruthy();
    }
  });

  it('never shrinks a limit as the tier grows', () => {
    for (const key of Object.keys(PLANS.starter.limits) as LimitKey[]) {
      let previous = -1;
      for (const tier of TIERS) {
        const limit = PLANS[tier].limits[key];
        // null is unlimited, so it can only ever appear at or after the point
        // where the numeric ladder ends.
        if (limit === null) {
          previous = Number.POSITIVE_INFINITY;
          continue;
        }
        expect(previous).not.toBe(Number.POSITIVE_INFINITY);
        expect(limit).toBeGreaterThanOrEqual(previous);
        previous = limit;
      }
    }
  });

  it('never removes a feature as the tier grows', () => {
    for (let index = 1; index < TIERS.length; index += 1) {
      const lower = PLANS[TIERS[index - 1]].features;
      const higher = PLANS[TIERS[index]];
      for (const feature of lower) {
        expect(hasFeature(higher.tier, feature)).toBe(true);
      }
    }
  });
});

describe('effectiveLimit', () => {
  it('falls back to the plan when nothing is negotiated', () => {
    expect(effectiveLimit('starter', 'seats')).toBe(5);
    expect(effectiveLimit('business', 'seats', {})).toBe(100);
    expect(effectiveLimit('business', 'seats', null)).toBe(100);
  });

  it('honours a negotiated override in both directions', () => {
    expect(effectiveLimit('starter', 'seats', { seats: 40 })).toBe(40);
    expect(effectiveLimit('business', 'seats', { seats: 10 })).toBe(10);
  });

  it('treats an explicit null override as unlimited', () => {
    // The distinction that matters: a contract can say "no cap on seats" for a
    // tenant who is not on enterprise, and that is not the same as no override.
    expect(effectiveLimit('starter', 'seats', { seats: null })).toBeNull();
  });

  it('ignores an override that is not a usable number', () => {
    expect(effectiveLimit('starter', 'seats', { seats: 'lots' })).toBe(5);
    expect(effectiveLimit('starter', 'seats', { seats: -1 })).toBe(5);
    expect(effectiveLimit('starter', 'seats', { seats: undefined })).toBe(5);
  });

  it('does not mistake an inherited property for an override', () => {
    // A body parsed from JSON cannot carry `seats` on its prototype, but a
    // plain object literal built in code can, and `in` would accept it.
    const overrides = Object.create({ seats: 999 }) as Record<string, unknown>;
    expect(effectiveLimit('starter', 'seats', overrides)).toBe(5);
  });

  it('leaves enterprise unlimited unless a contract caps it', () => {
    expect(effectiveLimit('enterprise', 'monthlyAiTokens')).toBeNull();
    expect(effectiveLimit('enterprise', 'monthlyAiTokens', { monthlyAiTokens: 1_000 })).toBe(1_000);
  });
});

describe('hasFeature', () => {
  it('gates a feature the plan does not include', () => {
    expect(hasFeature('starter', 'voice')).toBe(false);
    expect(hasFeature('professional', 'voice')).toBe(false);
    expect(hasFeature('business', 'voice')).toBe(true);
  });

  it('gives enterprise everything through the wildcard', () => {
    expect(hasFeature('enterprise', 'voice')).toBe(true);
    expect(hasFeature('enterprise', 'a_feature_that_does_not_exist_yet')).toBe(true);
  });
});
