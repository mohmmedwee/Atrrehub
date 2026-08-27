import { describe, expect, it } from 'vitest';
import {
  forecastAccuracy,
  forecastIntervals,
  seasonalKey,
  type HistoricalInterval,
} from './forecast';

const at = (iso: string) => new Date(iso);

/**
 * Consecutive Mondays at 10:00 UTC, oldest first, ending on 2026-03-02 — the
 * Monday immediately before the forecast window.
 */
function mondays(volumes: number[], hour = 10, handleTime?: number): HistoricalInterval[] {
  return volumes.map((volume, index) => ({
    startsAt: new Date(Date.UTC(2026, 2, 2 - 7 * (volumes.length - 1 - index), hour, 0)),
    volume,
    averageHandleTimeSec: handleTime,
  }));
}

describe('seasonalKey', () => {
  it('buckets by weekday and time of day', () => {
    expect(seasonalKey(at('2026-03-02T10:00:00Z'), 30)).toBe('1:600');
    expect(seasonalKey(at('2026-03-09T10:00:00Z'), 30)).toBe('1:600');
  });

  it('separates different weekdays at the same time', () => {
    expect(seasonalKey(at('2026-03-02T10:00:00Z'), 30)).not.toBe(
      seasonalKey(at('2026-03-03T10:00:00Z'), 30),
    );
  });

  it('rounds a time down into its interval', () => {
    expect(seasonalKey(at('2026-03-02T10:29:00Z'), 30)).toBe('1:600');
    expect(seasonalKey(at('2026-03-02T10:31:00Z'), 30)).toBe('1:630');
  });
});

describe('forecastIntervals', () => {
  const from = at('2026-03-09T10:00:00Z');
  const to = at('2026-03-09T10:30:00Z');

  it('predicts a steady history as itself', () => {
    const points = forecastIntervals(mondays([50, 50, 50, 50, 50, 50]), from, to);
    expect(points).toHaveLength(1);
    expect(points[0].volume).toBe(50);
    expect(points[0].confidence).toBe(1);
    expect(points[0].samples).toBe(6);
  });

  it('weights recent weeks more heavily than old ones', () => {
    // Volume has doubled recently; a flat mean would say 75.
    const points = forecastIntervals(mondays([50, 50, 50, 100, 100, 100]), from, to);
    expect(points[0].volume).toBeGreaterThan(75);
    expect(points[0].volume).toBeLessThan(100);
  });

  it('reports low confidence when little history exists', () => {
    const points = forecastIntervals(mondays([50, 50]), from, to, { lookbackWeeks: 6 });
    expect(points[0].samples).toBe(2);
    expect(points[0].confidence).toBeCloseTo(0.33, 2);
  });

  it('leaves an interval with no history at zero rather than inventing one', () => {
    // History is all Mondays; ask for a Tuesday.
    const points = forecastIntervals(
      mondays([50, 50, 50]),
      at('2026-03-10T10:00:00Z'),
      at('2026-03-10T10:30:00Z'),
    );
    expect(points[0].volume).toBe(0);
    expect(points[0].confidence).toBe(0);
    expect(points[0].samples).toBe(0);
  });

  it('ignores history outside the lookback window', () => {
    const points = forecastIntervals(mondays([999, 50, 50, 50]), from, to, { lookbackWeeks: 3 });
    expect(points[0].samples).toBe(3);
    expect(points[0].volume).toBe(50);
  });

  it('never predicts against the future', () => {
    const history = [
      ...mondays([50, 50, 50]),
      { startsAt: at('2026-03-16T10:00:00Z'), volume: 9999 },
    ];
    expect(forecastIntervals(history, from, to)[0].volume).toBe(50);
  });

  it('scales the whole forecast by a known growth factor', () => {
    const flat = forecastIntervals(mondays([100, 100, 100]), from, to);
    const grown = forecastIntervals(mondays([100, 100, 100]), from, to, { growthFactor: 1.2 });
    expect(grown[0].volume).toBe(Math.round(flat[0].volume * 1.2));
  });

  it('averages observed handle time, and falls back when none was recorded', () => {
    expect(forecastIntervals(mondays([50, 50], 10, 240), from, to)[0].averageHandleTimeSec).toBe(
      240,
    );
    expect(
      forecastIntervals(mondays([50, 50]), from, to, { defaultHandleTimeSec: 333 })[0]
        .averageHandleTimeSec,
    ).toBe(333);
  });

  it('produces one point per interval across the window', () => {
    const points = forecastIntervals(
      mondays([50, 50, 50]),
      at('2026-03-09T09:00:00Z'),
      at('2026-03-09T12:00:00Z'),
      { intervalMinutes: 30 },
    );
    expect(points).toHaveLength(6);
  });

  it('never predicts a negative volume', () => {
    const points = forecastIntervals(mondays([10, 10, 10]), from, to, { growthFactor: -5 });
    expect(points[0].volume).toBe(0);
  });

  it('treats an explicitly undefined option as absent, not as a value', () => {
    // Every optional field on a validated request body arrives as undefined,
    // and spreading that over the defaults used to produce NaN volumes.
    const points = forecastIntervals(mondays([50, 50, 50]), from, to, {
      growthFactor: undefined,
      lookbackWeeks: undefined,
      intervalMinutes: undefined,
      recencyWeight: undefined,
      defaultHandleTimeSec: undefined,
    });
    expect(points[0].volume).toBe(50);
    expect(Number.isNaN(points[0].volume)).toBe(false);
  });

  it('refuses a window that ends before it starts', () => {
    expect(() => forecastIntervals([], to, from)).toThrow();
  });
});

describe('forecastAccuracy', () => {
  const predicted = [
    { startsAt: at('2026-03-09T10:00:00Z'), volume: 100 },
    { startsAt: at('2026-03-09T10:30:00Z'), volume: 100 },
  ];

  it('scores a perfect forecast at zero error', () => {
    const actual = predicted.map((p) => ({ ...p }));
    expect(forecastAccuracy(predicted, actual)).toMatchObject({
      mape: 0,
      weightedMape: 0,
      bias: 0,
    });
  });

  it('reports positive bias when the forecast runs hot', () => {
    const actual = predicted.map((p) => ({ ...p, volume: 80 }));
    const result = forecastAccuracy(predicted, actual);
    expect(result.bias).toBeGreaterThan(0);
    expect(result.weightedMape).toBeCloseTo(25, 1);
  });

  it('reports negative bias when it under-forecasts — the expensive direction', () => {
    const actual = predicted.map((p) => ({ ...p, volume: 200 }));
    expect(forecastAccuracy(predicted, actual).bias).toBeLessThan(0);
  });

  it('shows why weighted MAPE is the number to act on', () => {
    // One busy interval forecast well, one quiet interval forecast badly.
    const busy = [
      { startsAt: at('2026-03-09T10:00:00Z'), volume: 1000 },
      { startsAt: at('2026-03-09T10:30:00Z'), volume: 2 },
    ];
    const actual = [
      { startsAt: at('2026-03-09T10:00:00Z'), volume: 1000 },
      { startsAt: at('2026-03-09T10:30:00Z'), volume: 1 },
    ];
    const result = forecastAccuracy(busy, actual);
    // Plain MAPE is alarmed by the interval nobody cares about.
    expect(result.mape).toBeCloseTo(50, 1);
    // Weighted MAPE sees a forecast that was essentially right.
    expect(result.weightedMape).toBeLessThan(1);
  });

  it('ignores predictions with no matching actual', () => {
    const actual = [{ startsAt: at('2026-03-09T10:00:00Z'), volume: 100 }];
    expect(forecastAccuracy(predicted, actual).weightedMape).toBe(0);
  });

  it('does not divide by zero on an interval with no contacts', () => {
    const actual = predicted.map((p) => ({ ...p, volume: 0 }));
    const result = forecastAccuracy(predicted, actual);
    expect(Number.isFinite(result.mape)).toBe(true);
    expect(Number.isFinite(result.weightedMape)).toBe(true);
  });
});
