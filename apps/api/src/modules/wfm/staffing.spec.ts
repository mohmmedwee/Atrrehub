import { describe, expect, it } from 'vitest';
import { calculateStaffing, erlangB, erlangC, evaluateStaffing, serviceLevel } from './staffing';

/**
 * Erlang is a century old and its reference values are not in dispute, so the
 * assertions below are against published figures rather than against whatever
 * this implementation happens to produce.
 */
describe('erlangB', () => {
  it('matches published blocking figures', () => {
    expect(erlangB(10, 10)).toBeCloseTo(0.2146, 3);
    expect(erlangB(20, 20)).toBeCloseTo(0.1591, 3);
    expect(erlangB(1, 1)).toBeCloseTo(0.5, 5);
  });

  it('blocks everything with no circuits', () => {
    expect(erlangB(0, 5)).toBe(1);
  });

  it('stays finite at an agent count that would overflow a factorial', () => {
    // 200! is Infinity in a double; the recursion does not care.
    const blocking = erlangB(200, 180);
    expect(Number.isFinite(blocking)).toBe(true);
    expect(blocking).toBeGreaterThan(0);
    expect(blocking).toBeLessThan(1);
  });
});

describe('erlangC', () => {
  it('matches the published waiting probability', () => {
    expect(erlangC(11, 10)).toBeCloseTo(0.6821, 3);
    expect(erlangC(15, 10)).toBeCloseTo(0.102, 3);
  });

  it('says everyone waits when the agents cannot carry the load', () => {
    expect(erlangC(10, 10)).toBe(1);
    expect(erlangC(8, 10)).toBe(1);
  });

  it('falls as agents are added', () => {
    const series = [12, 13, 14, 15, 16].map((agents) => erlangC(agents, 10));
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i]).toBeLessThan(series[i - 1]);
    }
  });

  it('is zero when there is no work', () => {
    expect(erlangC(5, 0)).toBe(0);
  });
});

describe('serviceLevel', () => {
  it('matches the textbook 80/20 example', () => {
    // 13 agents on 10 Erlangs falls just short of the 80% target, at 79.6%;
    // the 14th is what buys it, at 88.8%. Verified against an independent
    // implementation of the same recursion rather than from memory.
    expect(serviceLevel(13, 10, 180, 20)).toBeCloseTo(0.7956, 3);
    expect(serviceLevel(14, 10, 180, 20)).toBeCloseTo(0.8884, 3);
  });

  it('is zero when the queue is under water', () => {
    expect(serviceLevel(9, 10, 180, 20)).toBe(0);
  });

  it('rises with agents and with a looser target', () => {
    expect(serviceLevel(14, 10, 180, 20)).toBeGreaterThan(serviceLevel(13, 10, 180, 20));
    expect(serviceLevel(13, 10, 180, 60)).toBeGreaterThan(serviceLevel(13, 10, 180, 20));
  });
});

describe('calculateStaffing', () => {
  const base = {
    volume: 100,
    averageHandleTimeSec: 180,
    intervalSec: 1800,
    targetServiceLevel: 0.8,
    targetAnswerSec: 20,
  };

  it('sizes the classic 100 contacts / 3 minutes / half hour interval', () => {
    const result = calculateStaffing(base);
    expect(result.trafficIntensity).toBeCloseTo(10, 5);
    // 13 agents reach only 79.6%, so 80/20 at 10 Erlangs costs 14.
    expect(result.requiredAgents).toBe(14);
    expect(result.serviceLevel).toBeGreaterThanOrEqual(0.8);
  });

  it('never returns a staffing that misses its own target', () => {
    for (const volume of [10, 50, 100, 250, 500, 1000]) {
      const result = calculateStaffing({ ...base, volume });
      expect(result.serviceLevel).toBeGreaterThanOrEqual(base.targetServiceLevel);
    }
  });

  it('rosters more than it needs on the line, by the shrinkage', () => {
    const result = calculateStaffing({ ...base, shrinkage: 0.3 });
    expect(result.requiredAgents).toBe(14);
    // 14 on the line at 30% shrinkage means rostering 20.
    expect(result.rosteredAgents).toBe(20);
  });

  it('rosters exactly the requirement when nobody is ever away', () => {
    const result = calculateStaffing({ ...base, shrinkage: 0 });
    expect(result.rosteredAgents).toBe(result.requiredAgents);
  });

  it('respects the occupancy cap even when service level is already met', () => {
    const loose = calculateStaffing({ ...base, targetServiceLevel: 0.5, maxOccupancy: 1 });
    const capped = calculateStaffing({ ...base, targetServiceLevel: 0.5, maxOccupancy: 0.7 });

    expect(capped.requiredAgents).toBeGreaterThan(loose.requiredAgents);
    expect(capped.occupancy).toBeLessThanOrEqual(0.7);
  });

  it('staffs nobody for an interval with no contacts', () => {
    const result = calculateStaffing({ ...base, volume: 0 });
    expect(result.requiredAgents).toBe(0);
    expect(result.rosteredAgents).toBe(0);
    expect(result.serviceLevel).toBe(1);
  });

  it('needs more people for longer handle times', () => {
    const quick = calculateStaffing({ ...base, averageHandleTimeSec: 120 });
    const slow = calculateStaffing({ ...base, averageHandleTimeSec: 360 });
    expect(slow.requiredAgents).toBeGreaterThan(quick.requiredAgents);
  });

  it('scales sub-linearly, which is the whole point of pooling a queue', () => {
    const small = calculateStaffing({ ...base, volume: 100 });
    const large = calculateStaffing({ ...base, volume: 1000 });
    expect(large.requiredAgents).toBeLessThan(small.requiredAgents * 10);
    expect(large.occupancy).toBeGreaterThan(small.occupancy);
  });

  it('refuses impossible inputs rather than returning a plausible number', () => {
    expect(() => calculateStaffing({ ...base, intervalSec: 0 })).toThrow();
    expect(() => calculateStaffing({ ...base, shrinkage: 1 })).toThrow();
    expect(() => calculateStaffing({ ...base, shrinkage: -0.1 })).toThrow();
  });
});

describe('evaluateStaffing', () => {
  const input = {
    volume: 100,
    averageHandleTimeSec: 180,
    intervalSec: 1800,
    targetServiceLevel: 0.8,
    targetAnswerSec: 20,
  };

  it('answers the supervisor’s question: what do 11 people get me?', () => {
    const result = evaluateStaffing(11, input);
    expect(result.serviceLevel).toBeLessThan(0.8);
    expect(result.occupancy).toBeCloseTo(10 / 11, 3);
    expect(result.averageSpeedOfAnswerSec).toBeGreaterThan(20);
  });

  it('reports an unbounded wait when the queue cannot keep up', () => {
    expect(evaluateStaffing(9, input).averageSpeedOfAnswerSec).toBe(Number.POSITIVE_INFINITY);
    expect(evaluateStaffing(9, input).serviceLevel).toBe(0);
  });

  it('agrees with the calculator at the recommended headcount', () => {
    const required = calculateStaffing(input).requiredAgents;
    expect(evaluateStaffing(required, input).serviceLevel).toBeGreaterThanOrEqual(0.8);
  });
});
