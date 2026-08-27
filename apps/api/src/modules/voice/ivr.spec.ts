import { describe, expect, it } from 'vitest';
import { initialState, step, validateIvr, type IvrDefinition } from './ivr';

const flow: IvrDefinition = {
  entry: 'welcome',
  nodes: {
    welcome: {
      type: 'menu',
      prompt: 'Press 1 for billing, 2 for support, 9 for an agent.',
      options: { '1': 'billing', '2': 'ai_support', '9': 'operator' },
      onInvalid: undefined,
      maxRetries: 2,
    },
    billing: {
      type: 'collect',
      prompt: 'Please enter your account number, then hash.',
      field: 'accountNumber',
      maxDigits: 8,
      next: 'billing_queue',
    },
    billing_queue: { type: 'queue', queueId: 'que_billing', prompt: 'Connecting you now.' },
    ai_support: { type: 'ai_agent', agentId: 'agt_support', prompt: 'One moment.' },
    operator: { type: 'agent', userId: 'usr_operator' },
  },
};

const enter = () => step(flow, initialState(flow));

describe('entering a flow', () => {
  it('plays the first menu and waits for a digit', () => {
    const outcome = enter();
    expect(outcome.kind).toBe('continue');
    expect(outcome.actions[0]).toMatchObject({ kind: 'collect', maxDigits: 1 });
    if (outcome.kind === 'continue') expect(outcome.awaiting).toBe('digits');
  });

  it('records the path the caller took', () => {
    const outcome = enter();
    expect(outcome.state.path).toEqual(['welcome']);
  });
});

describe('routing on a keypress', () => {
  it('reaches a queue through a collect node', () => {
    const menu = enter();
    const afterDigit = step(flow, menu.state, { digits: '1' });
    expect(afterDigit.kind).toBe('continue');
    expect(afterDigit.actions[0]).toMatchObject({ maxDigits: 8, terminator: '#' });

    const afterAccount = step(flow, afterDigit.state, { digits: '55501234' });
    expect(afterAccount.kind).toBe('queue');
    if (afterAccount.kind === 'queue') expect(afterAccount.queueId).toBe('que_billing');
    expect(afterAccount.state.collected.accountNumber).toBe('55501234');
    expect(afterAccount.state.path).toEqual(['welcome', 'billing', 'billing_queue']);
  });

  it('routes to an AI agent', () => {
    const outcome = step(flow, enter().state, { digits: '2' });
    expect(outcome.kind).toBe('ai_agent');
    if (outcome.kind === 'ai_agent') expect(outcome.agentId).toBe('agt_support');
  });

  it('routes to a named person', () => {
    const outcome = step(flow, enter().state, { digits: '9' });
    expect(outcome.kind).toBe('agent');
    if (outcome.kind === 'agent') expect(outcome.userId).toBe('usr_operator');
  });
});

describe('a caller who gets it wrong', () => {
  it('re-prompts on an unmapped key without advancing', () => {
    const menu = enter();
    const outcome = step(flow, menu.state, { digits: '7' });
    expect(outcome.kind).toBe('continue');
    expect(outcome.state.nodeId).toBe('welcome');
    expect(outcome.state.retries).toBe(1);
    expect((outcome.actions[0] as { say?: string }).say).toContain('not one of the options');
  });

  it('re-prompts on silence', () => {
    const outcome = step(flow, enter().state, { timedOut: true });
    expect(outcome.kind).toBe('continue');
    expect(outcome.state.retries).toBe(1);
  });

  it('gives up after the retry budget rather than looping forever', () => {
    let state = enter().state;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      state = step(flow, state, { digits: '7' }).state;
    }
    const outcome = step(flow, state, { digits: '7' });
    expect(outcome.kind).toBe('hangup');
    expect(outcome.actions.some((a) => a.kind === 'hangup')).toBe(true);
  });

  it('says something before hanging up — never a silent cut-off', () => {
    let state = enter().state;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      state = step(flow, state, { timedOut: true }).state;
    }
    const outcome = step(flow, state, { timedOut: true });
    const spoken = outcome.actions.find((a) => a.kind === 'say');
    expect(spoken).toBeDefined();
  });

  it('resets the retry count once the caller succeeds', () => {
    const wrong = step(flow, enter().state, { digits: '7' });
    expect(wrong.state.retries).toBe(1);
    const right = step(flow, wrong.state, { digits: '2' });
    expect(right.state.retries).toBe(0);
  });
});

describe('explicit fallbacks', () => {
  const withFallbacks: IvrDefinition = {
    entry: 'menu',
    nodes: {
      menu: {
        type: 'menu',
        prompt: 'Press 1.',
        options: { '1': 'done' },
        onTimeout: 'operator',
        onInvalid: 'sorry',
      },
      sorry: { type: 'say', prompt: 'That was not an option.', next: 'operator' },
      operator: { type: 'queue', queueId: 'que_help' },
      done: { type: 'hangup', prompt: 'Thank you.' },
    },
  };

  it('uses onTimeout instead of retrying', () => {
    const state = step(withFallbacks, initialState(withFallbacks)).state;
    const outcome = step(withFallbacks, state, { timedOut: true });
    expect(outcome.kind).toBe('queue');
  });

  it('uses onInvalid, walking through the intermediate say node', () => {
    const state = step(withFallbacks, initialState(withFallbacks)).state;
    const outcome = step(withFallbacks, state, { digits: '4' });
    expect(outcome.kind).toBe('queue');
    expect(outcome.actions.some((a) => a.kind === 'say' && a.text.includes('not an option'))).toBe(
      true,
    );
  });
});

describe('broken flows', () => {
  it('does not spin forever on a cycle', () => {
    const looping: IvrDefinition = {
      entry: 'a',
      nodes: {
        a: { type: 'say', prompt: 'a', next: 'b' },
        b: { type: 'say', prompt: 'b', next: 'a' },
      },
    };
    const outcome = step(looping, initialState(looping));
    expect(outcome.kind).toBe('hangup');
  });

  it('ends the call when a node points nowhere', () => {
    const dangling: IvrDefinition = {
      entry: 'a',
      nodes: { a: { type: 'say', prompt: 'a', next: 'missing' } },
    };
    expect(step(dangling, initialState(dangling)).kind).toBe('hangup');
  });
});

describe('validateIvr', () => {
  it('accepts a sound flow', () => {
    expect(validateIvr(flow)).toEqual([]);
  });

  it('catches a dangling reference', () => {
    const errors = validateIvr({
      entry: 'a',
      nodes: { a: { type: 'menu', prompt: 'x', options: { '1': 'nowhere' } } },
    });
    expect(errors.some((e) => e.includes('nowhere'))).toBe(true);
  });

  it('catches a missing entry node', () => {
    const errors = validateIvr({ entry: 'ghost', nodes: { a: { type: 'hangup' } } });
    expect(errors.some((e) => e.includes('ghost'))).toBe(true);
  });

  it('catches a key that is not on a phone', () => {
    const errors = validateIvr({
      entry: 'a',
      nodes: { a: { type: 'menu', prompt: 'x', options: { A: 'a' } }, b: { type: 'hangup' } },
    });
    expect(errors.some((e) => e.includes('not a phone key'))).toBe(true);
  });

  it('catches a flow that never reaches a person or an ending', () => {
    const errors = validateIvr({
      entry: 'a',
      nodes: { a: { type: 'menu', prompt: 'x', options: { '1': 'a' } } },
    });
    expect(errors.some((e) => e.includes('never'))).toBe(false);
    expect(errors.some((e) => e.includes('reaches a person'))).toBe(true);
  });

  it('catches an empty menu', () => {
    const errors = validateIvr({
      entry: 'a',
      nodes: { a: { type: 'menu', prompt: 'x', options: {} }, b: { type: 'hangup' } },
    });
    expect(errors.some((e) => e.includes('no options'))).toBe(true);
  });
});
