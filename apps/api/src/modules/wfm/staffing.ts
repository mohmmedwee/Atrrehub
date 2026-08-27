/**
 * Staffing mathematics.
 *
 * Erlang C is what contact centres have used to size a queue for a century,
 * and it is the honest core of workforce management: everything else — shifts,
 * adherence, intraday reforecasting — exists to deliver the agent count this
 * calculation says an interval needs.
 *
 * The naive formula (A^N / N!) overflows a double at about N = 170, which is
 * an ordinary agent count for a large queue. Everything here is therefore
 * expressed through the Erlang B recursion, which is numerically stable at any
 * size and needs no factorials at all.
 */

export interface StaffingInput {
  /** Contacts arriving in the interval. */
  volume: number;
  /** Average handle time, seconds — talk plus wrap. */
  averageHandleTimeSec: number;
  /** Length of the interval, seconds. 15 or 30 minutes, usually. */
  intervalSec: number;
  /** Fraction answered within `targetAnswerSec`, 0-1. 0.8 is the classic. */
  targetServiceLevel: number;
  targetAnswerSec: number;
  /**
   * Time paid but not available: breaks, training, sickness, meetings.
   * Applied last, because it inflates *rostered* heads, not the heads the
   * queue needs on the line.
   */
  shrinkage?: number;
  /**
   * Nobody works at 100%. Above about 0.85 an agent has no recovery time
   * between contacts and average handle time starts to climb, which the model
   * does not capture — so it is capped rather than modelled.
   */
  maxOccupancy?: number;
}

export interface StaffingResult {
  /** Offered load in Erlangs: the agent-hours of work per hour of clock. */
  trafficIntensity: number;
  /** Agents needed on the line to hit the target. */
  requiredAgents: number;
  /** Agents to roster once shrinkage is added back. */
  rosteredAgents: number;
  /** Service level those agents actually achieve, 0-1. */
  serviceLevel: number;
  /** Fraction of their time they spend handling contacts, 0-1. */
  occupancy: number;
  /** Average seconds a contact waits before answer. */
  averageSpeedOfAnswerSec: number;
  /** Fraction of contacts that wait at all, 0-1. */
  probabilityOfWaiting: number;
}

const MAX_AGENTS = 10_000;

/**
 * Erlang B: the probability a call is lost in a system with no queue.
 *
 * Computed by the recursion B(n) = A·B(n-1) / (n + A·B(n-1)), which never
 * forms a factorial and so never overflows.
 */
export function erlangB(agents: number, intensity: number): number {
  if (agents <= 0) return 1;
  let b = 1;
  for (let n = 1; n <= agents; n += 1) {
    b = (intensity * b) / (n + intensity * b);
  }
  return b;
}

/**
 * Erlang C: the probability a contact has to wait, given a queue.
 *
 * Derived from Erlang B, which is what keeps it stable. Returns 1 when the
 * agents cannot carry the load at all — an under-staffed queue does not have a
 * "probability" of waiting, everybody waits, and the queue grows without
 * bound.
 */
export function erlangC(agents: number, intensity: number): number {
  if (agents <= 0) return 1;
  if (intensity <= 0) return 0;
  if (agents <= intensity) return 1;

  const b = erlangB(agents, intensity);
  const denominator = 1 - (intensity / agents) * (1 - b);
  if (denominator <= 0) return 1;

  return Math.min(1, b / denominator);
}

/** Fraction answered within `targetAnswerSec`. */
export function serviceLevel(
  agents: number,
  intensity: number,
  averageHandleTimeSec: number,
  targetAnswerSec: number,
): number {
  if (agents <= intensity) return 0;
  if (averageHandleTimeSec <= 0) return 1;

  const waiting = erlangC(agents, intensity);
  const decay = Math.exp((-(agents - intensity) * targetAnswerSec) / averageHandleTimeSec);
  return Math.max(0, Math.min(1, 1 - waiting * decay));
}

/** Average seconds in queue across every contact, answered immediately or not. */
export function averageSpeedOfAnswer(
  agents: number,
  intensity: number,
  averageHandleTimeSec: number,
): number {
  if (agents <= intensity) return Number.POSITIVE_INFINITY;
  return (erlangC(agents, intensity) * averageHandleTimeSec) / (agents - intensity);
}

/**
 * How many agents an interval needs.
 *
 * Walks up from the smallest agent count that can carry the load at all, and
 * stops at the first that meets both the service level and the occupancy cap.
 * Linear search rather than anything cleverer because service level is
 * monotonic in agents and the counts involved are small — a binary search
 * would save microseconds and cost the reader a proof.
 */
export function calculateStaffing(input: StaffingInput): StaffingResult {
  const {
    volume,
    averageHandleTimeSec,
    intervalSec,
    targetServiceLevel,
    targetAnswerSec,
    shrinkage = 0,
    maxOccupancy = 0.85,
  } = input;

  if (intervalSec <= 0) throw new Error('An interval must have a length');
  if (shrinkage < 0 || shrinkage >= 1) throw new Error('Shrinkage must be between 0 and 1');

  const intensity = (volume * averageHandleTimeSec) / intervalSec;

  // An interval with no contacts needs nobody, and saying "one, just in case"
  // here would quietly add a head to every empty night interval of the year.
  if (intensity <= 0) {
    return {
      trafficIntensity: 0,
      requiredAgents: 0,
      rosteredAgents: 0,
      serviceLevel: 1,
      occupancy: 0,
      averageSpeedOfAnswerSec: 0,
      probabilityOfWaiting: 0,
    };
  }

  let agents = Math.max(1, Math.floor(intensity) + 1);
  while (agents < MAX_AGENTS) {
    const achieved = serviceLevel(agents, intensity, averageHandleTimeSec, targetAnswerSec);
    const occupancy = intensity / agents;

    if (achieved >= targetServiceLevel && occupancy <= maxOccupancy) break;
    agents += 1;
  }

  const achieved = serviceLevel(agents, intensity, averageHandleTimeSec, targetAnswerSec);

  return {
    trafficIntensity: round(intensity, 3),
    requiredAgents: agents,
    // Shrinkage inflates the roster, not the line: 10 agents needed at 30%
    // shrinkage means rostering 15, because 5 of them are on a break.
    rosteredAgents: Math.ceil(agents / (1 - shrinkage)),
    serviceLevel: round(achieved, 4),
    occupancy: round(intensity / agents, 4),
    averageSpeedOfAnswerSec: round(
      averageSpeedOfAnswer(agents, intensity, averageHandleTimeSec),
      1,
    ),
    probabilityOfWaiting: round(erlangC(agents, intensity), 4),
  };
}

/**
 * What a *given* number of agents would actually deliver.
 *
 * The inverse question, and the one a supervisor asks at 9am: "I have eleven
 * people, not thirteen — what does that do to the queue?"
 */
export function evaluateStaffing(
  agents: number,
  input: Omit<StaffingInput, 'shrinkage' | 'maxOccupancy'>,
): Omit<StaffingResult, 'requiredAgents' | 'rosteredAgents'> {
  const intensity = (input.volume * input.averageHandleTimeSec) / input.intervalSec;

  return {
    trafficIntensity: round(intensity, 3),
    serviceLevel: round(
      serviceLevel(agents, intensity, input.averageHandleTimeSec, input.targetAnswerSec),
      4,
    ),
    occupancy: agents > 0 ? round(intensity / agents, 4) : 0,
    averageSpeedOfAnswerSec: round(
      averageSpeedOfAnswer(agents, intensity, input.averageHandleTimeSec),
      1,
    ),
    probabilityOfWaiting: round(erlangC(agents, intensity), 4),
  };
}

function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
