import type { CallAction } from './telephony-adapter';

/**
 * The IVR: a menu tree, evaluated one step at a time.
 *
 * Deliberately not the workflow runtime. A workflow is a durable, long-running
 * graph with suspend and resume; an IVR turn is a caller waiting in silence
 * with a few hundred milliseconds of patience, and the operations it needs —
 * "play this, collect one digit, retry twice, then give up" — are a different
 * vocabulary. Sharing the runtime would have meant bending both.
 *
 * The evaluator is pure: state in, actions and next state out. Every awkward
 * case a real caller produces — no input, an invalid key, a retry budget
 * running out, a menu that loops back on itself — is a value it returns, not
 * an exception it throws.
 */

export type IvrNode =
  | {
      type: 'menu';
      /** Spoken before the options. */
      prompt: string;
      /** Digit → next node. */
      options: Record<string, string>;
      timeoutSec?: number;
      /** Where to go when the caller presses nothing, after the retries. */
      onTimeout?: string;
      /** Where to go when the caller presses something unmapped. */
      onInvalid?: string;
      maxRetries?: number;
      /** Spoken before a retry; a bare repeat of the menu is disorienting. */
      retryPrompt?: string;
    }
  | { type: 'say'; prompt: string; next?: string }
  | {
      type: 'collect';
      prompt: string;
      /** Where the digits land in the call's collected data. */
      field: string;
      maxDigits: number;
      terminator?: string;
      timeoutSec?: number;
      next?: string;
      onTimeout?: string;
      maxRetries?: number;
    }
  | { type: 'queue'; queueId: string; prompt?: string; holdMusicUrl?: string }
  | { type: 'agent'; userId: string; prompt?: string }
  | { type: 'ai_agent'; agentId: string; prompt?: string }
  | { type: 'transfer'; to: string; prompt?: string }
  | { type: 'voicemail'; prompt: string; maxSeconds?: number }
  | { type: 'hangup'; prompt?: string };

export interface IvrDefinition {
  entry: string;
  nodes: Record<string, IvrNode>;
}

export interface IvrState {
  nodeId: string;
  /** Retries spent on the current node; reset whenever the node changes. */
  retries: number;
  /** Nodes visited, in order — the path a caller actually took. */
  path: string[];
  /** Digits gathered by `collect` nodes, keyed by their field. */
  collected: Record<string, string>;
}

export type IvrOutcome =
  | { kind: 'continue'; actions: CallAction[]; state: IvrState; awaiting: 'digits' | 'none' }
  | { kind: 'queue'; queueId: string; actions: CallAction[]; state: IvrState }
  | { kind: 'agent'; userId: string; actions: CallAction[]; state: IvrState }
  | { kind: 'ai_agent'; agentId: string; actions: CallAction[]; state: IvrState }
  | { kind: 'transfer'; to: string; actions: CallAction[]; state: IvrState }
  | { kind: 'voicemail'; actions: CallAction[]; state: IvrState }
  | { kind: 'hangup'; actions: CallAction[]; state: IvrState };

/** How many nodes one input may traverse before the flow is called circular. */
const MAX_HOPS = 25;
const DEFAULT_TIMEOUT_SEC = 6;
const DEFAULT_MAX_RETRIES = 2;

export function initialState(definition: IvrDefinition): IvrState {
  return { nodeId: definition.entry, retries: 0, path: [], collected: {} };
}

/**
 * Advance the flow.
 *
 * `input` is what the caller just did: digits, or nothing at all when the
 * collection timed out. It is undefined on the first call, when the flow is
 * simply entering its first node.
 */
export function step(
  definition: IvrDefinition,
  state: IvrState,
  input?: { digits?: string; timedOut?: boolean },
): IvrOutcome {
  let current: IvrState = { ...state, collected: { ...state.collected } };
  const actions: CallAction[] = [];

  // Resolve the caller's input against the node they were sitting on before
  // walking forward, so a retry stays on the same node rather than advancing.
  if (input) {
    const node = definition.nodes[current.nodeId];
    if (!node) return fail(current, actions);

    const resolved = resolveInput(node, current, input);
    if (resolved.kind === 'retry') {
      return {
        kind: 'continue',
        actions: resolved.actions,
        state: resolved.state,
        awaiting: 'digits',
      };
    }
    if (resolved.kind === 'stay') return fail(resolved.state, resolved.actions);
    current = resolved.state;
    actions.push(...resolved.actions);
  }

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const node = definition.nodes[current.nodeId];
    if (!node) return fail(current, actions);

    if (current.path[current.path.length - 1] !== current.nodeId)
      current = { ...current, path: [...current.path, current.nodeId] };

    switch (node.type) {
      case 'say':
        actions.push({ kind: 'say', text: node.prompt });
        if (!node.next)
          return { kind: 'hangup', actions: [...actions, { kind: 'hangup' }], state: current };
        current = { ...current, nodeId: node.next, retries: 0 };
        continue;

      case 'menu':
        actions.push({
          kind: 'collect',
          say: node.prompt,
          maxDigits: 1,
          timeoutSec: node.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
        });
        return { kind: 'continue', actions, state: current, awaiting: 'digits' };

      case 'collect':
        actions.push({
          kind: 'collect',
          say: node.prompt,
          maxDigits: node.maxDigits,
          terminator: node.terminator ?? '#',
          timeoutSec: node.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
        });
        return { kind: 'continue', actions, state: current, awaiting: 'digits' };

      case 'queue':
        if (node.prompt) actions.push({ kind: 'say', text: node.prompt });
        actions.push({ kind: 'enqueue', queueId: node.queueId, holdMusicUrl: node.holdMusicUrl });
        return { kind: 'queue', queueId: node.queueId, actions, state: current };

      case 'agent':
        if (node.prompt) actions.push({ kind: 'say', text: node.prompt });
        return { kind: 'agent', userId: node.userId, actions, state: current };

      case 'ai_agent':
        if (node.prompt) actions.push({ kind: 'say', text: node.prompt });
        return { kind: 'ai_agent', agentId: node.agentId, actions, state: current };

      case 'transfer':
        if (node.prompt) actions.push({ kind: 'say', text: node.prompt });
        actions.push({ kind: 'bridge', to: node.to });
        return { kind: 'transfer', to: node.to, actions, state: current };

      case 'voicemail':
        actions.push({ kind: 'say', text: node.prompt });
        actions.push({ kind: 'record', maxSeconds: node.maxSeconds ?? 120, beep: true });
        return { kind: 'voicemail', actions, state: current };

      case 'hangup':
        if (node.prompt) actions.push({ kind: 'say', text: node.prompt });
        actions.push({ kind: 'hangup' });
        return { kind: 'hangup', actions, state: current };
    }
  }

  // A flow that never reaches a terminal node would otherwise hold a caller on
  // a silent line forever.
  return fail(current, actions);
}

type Resolution =
  | { kind: 'advance'; state: IvrState; actions: CallAction[] }
  | { kind: 'retry'; state: IvrState; actions: CallAction[] }
  | { kind: 'stay'; state: IvrState; actions: CallAction[] };

function resolveInput(
  node: IvrNode,
  state: IvrState,
  input: { digits?: string; timedOut?: boolean },
): Resolution {
  if (node.type === 'menu') {
    const digits = input.digits?.trim();

    if (!digits || input.timedOut) {
      if (node.onTimeout) return advance(state, node.onTimeout);
      return retryOrGiveUp(node, state, node.retryPrompt ?? node.prompt);
    }

    const next = node.options[digits];
    if (next) return advance(state, next);
    if (node.onInvalid) return advance(state, node.onInvalid);
    return retryOrGiveUp(
      node,
      state,
      node.retryPrompt ?? `Sorry, ${digits} is not one of the options. ${node.prompt}`,
    );
  }

  if (node.type === 'collect') {
    const digits = input.digits?.trim();

    if (!digits || input.timedOut) {
      if (node.onTimeout) return advance(state, node.onTimeout);
      return retryOrGiveUp(node, state, node.prompt);
    }

    const collected = { ...state.collected, [node.field]: digits };
    if (!node.next) return { kind: 'stay', state: { ...state, collected }, actions: [] };
    return {
      kind: 'advance',
      state: { ...state, collected, nodeId: node.next, retries: 0 },
      actions: [],
    };
  }

  // Any other node type is terminal and takes no input; re-entering it simply
  // replays it.
  return { kind: 'advance', state, actions: [] };
}

function retryOrGiveUp(
  node: Extract<IvrNode, { type: 'menu' | 'collect' }>,
  state: IvrState,
  prompt: string,
): Resolution {
  const limit = node.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (state.retries >= limit) return { kind: 'stay', state, actions: [] };

  const maxDigits = node.type === 'menu' ? 1 : node.maxDigits;
  return {
    kind: 'retry',
    state: { ...state, retries: state.retries + 1 },
    actions: [
      {
        kind: 'collect',
        say: prompt,
        maxDigits,
        ...(node.type === 'collect' ? { terminator: node.terminator ?? '#' } : {}),
        timeoutSec: node.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
      },
    ],
  };
}

function advance(state: IvrState, nodeId: string): Resolution {
  return { kind: 'advance', state: { ...state, nodeId, retries: 0 }, actions: [] };
}

/**
 * The last resort: a caller who has exhausted their retries, or hit a broken
 * flow, is told what is happening and put through to a person's queue if the
 * flow named one — never left on a silent line, and never simply cut off
 * without a word.
 */
function fail(state: IvrState, actions: CallAction[]): IvrOutcome {
  return {
    kind: 'hangup',
    actions: [
      ...actions,
      { kind: 'say', text: 'Sorry, we could not process that. Please call again.' },
      { kind: 'hangup', cause: 'ivr_exhausted' },
    ],
    state,
  };
}

/** Structural problems worth refusing at save time rather than discovering on a call. */
export function validateIvr(definition: IvrDefinition): string[] {
  const errors: string[] = [];
  const ids = Object.keys(definition.nodes ?? {});

  if (!definition.entry) errors.push('The flow has no entry node');
  else if (!definition.nodes?.[definition.entry])
    errors.push(`The entry node "${definition.entry}" does not exist`);
  if (!ids.length) errors.push('The flow has no nodes');

  const reference = (from: string, to: string | undefined, label: string) => {
    if (to && !definition.nodes[to])
      errors.push(`"${from}" ${label} "${to}", which does not exist`);
  };

  for (const [id, node] of Object.entries(definition.nodes ?? {})) {
    switch (node.type) {
      case 'menu':
        if (!Object.keys(node.options ?? {}).length) errors.push(`Menu "${id}" offers no options`);
        for (const [digit, target] of Object.entries(node.options ?? {})) {
          if (!/^[0-9*#]$/.test(digit))
            errors.push(`Menu "${id}" maps "${digit}", which is not a phone key`);
          reference(id, target, `routes ${digit} to`);
        }
        reference(id, node.onTimeout, 'times out to');
        reference(id, node.onInvalid, 'sends invalid input to');
        break;
      case 'collect':
        if (!node.field) errors.push(`Collect "${id}" does not say where to store the digits`);
        reference(id, node.next, 'continues to');
        reference(id, node.onTimeout, 'times out to');
        break;
      case 'say':
        reference(id, node.next, 'continues to');
        break;
      default:
        break;
    }
  }

  // A flow whose every path loops is a caller trapped in a menu.
  const terminals = Object.values(definition.nodes ?? {}).filter((node) =>
    ['queue', 'agent', 'ai_agent', 'transfer', 'voicemail', 'hangup'].includes(node.type),
  );
  if (ids.length && !terminals.length)
    errors.push('No node in this flow reaches a person, an AI agent or a hangup');

  return errors;
}
