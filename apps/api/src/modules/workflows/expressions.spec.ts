import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateExpression, interpolate, resolvePath } from './expressions';

const scope = {
  customer: { tier: 'gold', name: 'Layla', age: 34, tags: ['billing', 'vip'] },
  conversation: { channel: 'email', priority: 'high', locale: 'ar' },
  ai: { intent: 'refund_request', confidence: 0.82, sentiment: -0.4 },
  empty: { list: [], value: null },
};

describe('expression evaluation', () => {
  it('resolves a nested path', () => {
    expect(evaluateExpression('customer.tier', scope)).toBe('gold');
    expect(evaluateExpression('customer.name', scope)).toBe('Layla');
  });

  it('returns undefined for a missing path rather than throwing', () => {
    expect(evaluateExpression('customer.missing.deep', scope)).toBeUndefined();
  });

  it('compares for equality, case-insensitively for strings', () => {
    expect(evaluateCondition('customer.tier == "gold"', scope)).toBe(true);
    expect(evaluateCondition('customer.tier == "GOLD"', scope)).toBe(true);
    expect(evaluateCondition('customer.tier == "silver"', scope)).toBe(false);
    expect(evaluateCondition('customer.tier != "silver"', scope)).toBe(true);
  });

  it('compares numerically', () => {
    expect(evaluateCondition('customer.age > 30', scope)).toBe(true);
    expect(evaluateCondition('customer.age >= 34', scope)).toBe(true);
    expect(evaluateCondition('ai.confidence < 0.9', scope)).toBe(true);
    expect(evaluateCondition('ai.sentiment < 0', scope)).toBe(true);
  });

  it('composes with and, or and not', () => {
    expect(evaluateCondition('customer.tier == "gold" and customer.age > 30', scope)).toBe(true);
    expect(evaluateCondition('customer.tier == "bronze" or conversation.channel == "email"', scope)).toBe(true);
    expect(evaluateCondition('not (customer.tier == "bronze")', scope)).toBe(true);
    expect(evaluateCondition('customer.tier == "gold" and customer.age > 90', scope)).toBe(false);
  });

  it('respects parentheses', () => {
    expect(evaluateCondition('(customer.tier == "bronze" or customer.age > 30) and conversation.channel == "email"', scope)).toBe(true);
    expect(evaluateCondition('customer.tier == "bronze" or (customer.age > 30 and conversation.channel == "sms")', scope)).toBe(false);
  });

  it('tests membership in an array value', () => {
    expect(evaluateCondition('customer.tags contains "vip"', scope)).toBe(true);
    expect(evaluateCondition('customer.tags contains "enterprise"', scope)).toBe(false);
  });

  it('tests membership in a literal list', () => {
    expect(evaluateCondition('conversation.priority in ["high", "urgent", "critical"]', scope)).toBe(true);
    expect(evaluateCondition('conversation.priority in ["low", "normal"]', scope)).toBe(false);
  });

  it('supports substring, prefix and suffix tests', () => {
    expect(evaluateCondition('ai.intent contains "refund"', scope)).toBe(true);
    expect(evaluateCondition('ai.intent startsWith "refund"', scope)).toBe(true);
    expect(evaluateCondition('ai.intent endsWith "request"', scope)).toBe(true);
  });

  it('supports regular expression matching', () => {
    expect(evaluateCondition('ai.intent matches "^refund_"', scope)).toBe(true);
    expect(evaluateCondition('ai.intent matches "^cancel_"', scope)).toBe(false);
  });

  it('treats an empty array and null as falsy', () => {
    expect(evaluateCondition('empty.list', scope)).toBe(false);
    expect(evaluateCondition('empty.value', scope)).toBe(false);
    expect(evaluateCondition('customer.tags', scope)).toBe(true);
  });

  it('treats an empty expression as true so an unconditioned edge is always taken', () => {
    expect(evaluateCondition('', scope)).toBe(true);
    expect(evaluateCondition('   ', scope)).toBe(true);
  });

  it('cannot execute arbitrary code', () => {
    // These are the shapes that would matter if the evaluator were `eval`.
    for (const attack of [
      'process.exit(1)',
      'require("fs")',
      'constructor.constructor("return 1")()',
      'globalThis.process',
    ]) {
      // Either it refuses to parse, or it resolves to a harmless undefined —
      // never to a call.
      let result: unknown;
      try {
        result = evaluateExpression(attack, scope);
      } catch {
        result = undefined;
      }
      expect(result === undefined || result === false || result === null).toBe(true);
    }
  });

  it('rejects malformed input rather than guessing', () => {
    expect(() => evaluateExpression('customer.tier ==', scope)).toThrow();
    expect(() => evaluateExpression('(customer.tier == "gold"', scope)).toThrow();
    expect(() => evaluateExpression('customer.tier @@ "gold"', scope)).toThrow();
  });
});

describe('interpolation', () => {
  it('substitutes a placeholder', () => {
    expect(interpolate('Hello {{ customer.name }}', scope)).toBe('Hello Layla');
  });

  it('substitutes several placeholders', () => {
    expect(interpolate('{{customer.name}} is {{customer.tier}}', scope)).toBe('Layla is gold');
  });

  it('renders a missing value as empty rather than "undefined"', () => {
    expect(interpolate('Hello {{ customer.missing }}!', scope)).toBe('Hello !');
  });

  it('serializes a non-string value', () => {
    expect(interpolate('{{ customer.age }}', scope)).toBe('34');
    expect(interpolate('{{ customer.tags }}', scope)).toBe('["billing","vip"]');
  });

  it('leaves text with no placeholders untouched', () => {
    expect(interpolate('No placeholders here.', scope)).toBe('No placeholders here.');
  });
});

describe('path resolution', () => {
  it('reads a top-level key', () => {
    expect(resolvePath('customer', scope)).toEqual(scope.customer);
  });

  it('reads an array element by index', () => {
    expect(resolvePath('customer.tags[0]', scope)).toBe('billing');
  });
});
