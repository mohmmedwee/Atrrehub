import { describe, expect, it } from 'vitest';
import { ERASED, ERASURE_PLAN, assertPlanIsOrdered, type ErasureStep } from './erasure-plan';

describe('ERASURE_PLAN', () => {
  it('erases the customer row last', () => {
    // Everything else is found by following the customer. Deleting it first
    // would strand the transcripts, which is worse than not erasing at all
    // because it looks like erasing.
    expect(ERASURE_PLAN.at(-1)?.model).toBe('customer');
    expect(() => assertPlanIsOrdered()).not.toThrow();
  });

  it('rejects a plan that erases the customer too early', () => {
    const wrong: ErasureStep[] = [
      { model: 'customer', action: 'delete', because: 'wrong' },
      { model: 'message', action: 'redact', fields: ['body'], because: 'wrong' },
    ];
    expect(() => assertPlanIsOrdered(wrong)).toThrow(/last/i);
  });

  it('covers every table that holds the subject’s own words', () => {
    const models = new Set(ERASURE_PLAN.map((step) => step.model));
    for (const model of [
      'message',
      'conversation',
      'ticket',
      'customerNote',
      'memoryEntry',
      'callRecording',
      'callEvent',
      'attachment',
      'contactMethod',
    ]) {
      expect(models.has(model), `${model} is not in the erasure plan`).toBe(true);
    }
  });

  it('gives every step a reason', () => {
    for (const step of ERASURE_PLAN) {
      expect(step.because.length, `${step.model} has no rationale`).toBeGreaterThan(20);
    }
  });

  it('names fields on every redaction and on no deletion', () => {
    for (const step of ERASURE_PLAN) {
      if (step.action === 'redact') {
        expect(step.fields?.length, `${step.model} redacts nothing`).toBeGreaterThan(0);
      } else {
        expect(step.fields, `${step.model} deletes but names fields`).toBeUndefined();
      }
    }
  });

  it('deletes the stored object alongside the row for anything held in storage', () => {
    // A row deleted without its file leaves the subject's voice or attachment
    // sitting in object storage with nothing pointing at it.
    const withObjects = ERASURE_PLAN.filter((step) => step.action === 'delete_with_object');
    expect(withObjects.map((step) => step.model).sort()).toEqual(['attachment', 'callRecording']);
  });

  it('lists no model twice', () => {
    const models = ERASURE_PLAN.map((step) => step.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it('leaves a tombstone rather than a blank', () => {
    // A blank body is indistinguishable from a bug; an agent scrolling the
    // conversation needs to see that something was removed on purpose.
    expect(ERASED).toMatch(/erased/i);
    expect(ERASED.length).toBeGreaterThan(10);
  });

  it('redacts the conversation rather than deleting it', () => {
    // Deleting it would take the agent's replies, the SLA record and the
    // quality evaluations with it — none of which are the subject's data.
    const conversation = ERASURE_PLAN.find((step) => step.model === 'conversation');
    expect(conversation?.action).toBe('redact');
    expect(conversation?.fields).toContain('customerId');
    expect(conversation?.fields).toContain('subject');
  });

  it('unlinks the customer wherever the row survives', () => {
    // A surviving row that still carries customerId points at a person who no
    // longer exists, and re-identifies them the moment anything joins on it.
    for (const model of ['conversation', 'ticket', 'call']) {
      const step = ERASURE_PLAN.find((entry) => entry.model === model);
      expect(step?.fields, `${model} keeps its customer link`).toContain('customerId');
    }
  });
});
