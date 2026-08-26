import { describe, expect, it } from 'vitest';
import { RoutingService, type RoutingSubject } from './routing.service';

const { matchesConditions } = RoutingService;

const subject = (overrides: Partial<RoutingSubject> = {}): RoutingSubject => ({
  channel: 'email',
  locale: 'en',
  priority: 'normal',
  customerTier: 'gold',
  tags: ['billing'],
  intent: 'refund_request',
  sentimentScore: 0.2,
  ...overrides,
});

describe('routing rule matching', () => {
  it('matches a single condition', () => {
    expect(matchesConditions({ channel: 'email' }, subject())).toBe(true);
    expect(matchesConditions({ channel: 'web_chat' }, subject())).toBe(false);
  });

  it('accepts a list as an OR over values', () => {
    expect(matchesConditions({ channel: ['web_chat', 'email'] }, subject())).toBe(true);
    expect(matchesConditions({ channel: ['voice', 'sms'] }, subject())).toBe(false);
  });

  it('requires every condition to hold', () => {
    expect(matchesConditions({ channel: 'email', priority: 'normal' }, subject())).toBe(true);
    expect(matchesConditions({ channel: 'email', priority: 'critical' }, subject())).toBe(false);
  });

  it('matches a rule on language, which the Arabic routing example depends on', () => {
    expect(matchesConditions({ language: 'ar' }, subject({ locale: 'ar' }))).toBe(true);
    expect(matchesConditions({ language: 'ar' }, subject({ locale: 'en' }))).toBe(false);
  });

  it('matches tags when any listed tag is present', () => {
    expect(matchesConditions({ tags: ['billing', 'vip'] }, subject())).toBe(true);
    expect(matchesConditions({ tags: ['network'] }, subject())).toBe(false);
    expect(matchesConditions({ tags: ['billing'] }, subject({ tags: [] }))).toBe(false);
  });

  it('routes on AI intent and sentiment', () => {
    expect(matchesConditions({ intent: 'refund_request' }, subject())).toBe(true);
    expect(matchesConditions({ sentimentBelow: 0.3 }, subject({ sentimentScore: 0.2 }))).toBe(true);
    expect(matchesConditions({ sentimentBelow: 0.3 }, subject({ sentimentScore: 0.5 }))).toBe(false);
  });

  it('does not match a sentiment rule when no sentiment has been extracted yet', () => {
    expect(matchesConditions({ sentimentBelow: 0.3 }, subject({ sentimentScore: null }))).toBe(false);
  });

  it('does not match a tier rule for a customer with no tier', () => {
    expect(matchesConditions({ tier: 'gold' }, subject({ customerTier: null }))).toBe(false);
  });

  it('treats an empty condition set as matching nothing, not everything', () => {
    expect(matchesConditions({}, subject())).toBe(false);
  });

  it('fails closed on an unrecognised condition key', () => {
    expect(matchesConditions({ nonsense: 'value' }, subject())).toBe(false);
    // …even alongside conditions that would otherwise match.
    expect(matchesConditions({ channel: 'email', nonsense: 'value' }, subject())).toBe(false);
  });
});
