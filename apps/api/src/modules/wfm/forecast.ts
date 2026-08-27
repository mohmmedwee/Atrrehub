/**
 * Contact volume forecasting.
 *
 * Deliberately a seasonal model rather than anything machine-learned. Contact
 * arrival is dominated by two cycles — time of day and day of week — and a
 * seasonal average over recent like-for-like intervals beats a general
 * regression on this data while staying explicable to the person who has to
 * defend the roster it produces.
 *
 * Everything here is pure: history in, prediction out.
 */

export interface HistoricalInterval {
  /** Start of the interval, in the organization's own timezone. */
  startsAt: Date;
  volume: number;
  /** Average handle time observed, seconds. */
  averageHandleTimeSec?: number;
}

export interface ForecastPoint {
  startsAt: Date;
  volume: number;
  averageHandleTimeSec: number;
  /**
   * How much history stood behind this point, 0-1. A Tuesday 10am with eight
   * weeks of history is trustworthy; a bank holiday with none is a guess, and
   * the roster should be able to tell them apart.
   */
  confidence: number;
  /** Weeks of like-for-like history the point was drawn from. */
  samples: number;
}

export interface ForecastOptions {
  /** Weeks of history to average. Four to eight is the usual range. */
  lookbackWeeks?: number;
  intervalMinutes?: number;
  /** Scales the whole forecast — a known campaign, a price change. */
  growthFactor?: number;
  /** Fallback when an interval has no history at all. */
  defaultHandleTimeSec?: number;
  /**
   * Weight recent weeks more heavily. 1 means every week counts the same;
   * below 1 decays older weeks geometrically.
   */
  recencyWeight?: number;
}

const DEFAULTS = {
  lookbackWeeks: 6,
  intervalMinutes: 30,
  growthFactor: 1,
  defaultHandleTimeSec: 300,
  recencyWeight: 0.85,
};

/** Key an interval by its position in the week: weekday plus minutes into the day. */
export function seasonalKey(at: Date, intervalMinutes: number): string {
  const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes();
  const bucket = Math.floor(minuteOfDay / intervalMinutes) * intervalMinutes;
  return `${at.getUTCDay()}:${bucket}`;
}

/**
 * Forecast every interval between `from` and `to`.
 *
 * An interval with no matching history is reported at zero with zero
 * confidence rather than being filled in from a neighbouring hour: a made-up
 * number that looks like a real one is worse than an obvious gap, because
 * somebody will roster against it.
 */
export function forecastIntervals(
  history: HistoricalInterval[],
  from: Date,
  to: Date,
  options: ForecastOptions = {},
): ForecastPoint[] {
  // Resolved field by field rather than by spreading over the defaults: a
  // caller passing `{ growthFactor: undefined }` — which any optional field on
  // a request body produces — would otherwise *overwrite* the default with
  // undefined and turn every prediction into NaN.
  const lookbackWeeks = options.lookbackWeeks ?? DEFAULTS.lookbackWeeks;
  const intervalMinutes = options.intervalMinutes ?? DEFAULTS.intervalMinutes;
  const growthFactor = options.growthFactor ?? DEFAULTS.growthFactor;
  const defaultHandleTimeSec = options.defaultHandleTimeSec ?? DEFAULTS.defaultHandleTimeSec;
  const recencyWeight = options.recencyWeight ?? DEFAULTS.recencyWeight;

  if (from >= to) throw new Error('A forecast window starts before it ends');
  const intervalMs = intervalMinutes * 60_000;

  // Bucket history by its position in the week, newest first, so the recency
  // weighting below can simply walk the list.
  const buckets = new Map<string, HistoricalInterval[]>();
  const cutoff = new Date(from.getTime() - lookbackWeeks * 7 * 86_400_000);

  for (const entry of history) {
    if (entry.startsAt < cutoff || entry.startsAt >= from) continue;
    const key = seasonalKey(entry.startsAt, intervalMinutes);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  }

  const points: ForecastPoint[] = [];
  for (let at = from.getTime(); at < to.getTime(); at += intervalMs) {
    const startsAt = new Date(at);
    const matches = buckets.get(seasonalKey(startsAt, intervalMinutes)) ?? [];

    if (!matches.length) {
      points.push({
        startsAt,
        volume: 0,
        averageHandleTimeSec: defaultHandleTimeSec,
        confidence: 0,
        samples: 0,
      });
      continue;
    }

    let weightSum = 0;
    let volumeSum = 0;
    let handleTimeSum = 0;
    let handleTimeWeight = 0;

    matches.forEach((entry, index) => {
      const weight = recencyWeight ** index;
      weightSum += weight;
      volumeSum += entry.volume * weight;
      if (entry.averageHandleTimeSec && entry.averageHandleTimeSec > 0) {
        handleTimeSum += entry.averageHandleTimeSec * weight;
        handleTimeWeight += weight;
      }
    });

    points.push({
      startsAt,
      volume: Math.max(0, Math.round((volumeSum / weightSum) * growthFactor)),
      averageHandleTimeSec: handleTimeWeight
        ? Math.round(handleTimeSum / handleTimeWeight)
        : defaultHandleTimeSec,
      // Confidence is simply how much of the requested lookback actually
      // existed — three weeks out of six is half a forecast.
      confidence: round(Math.min(1, matches.length / lookbackWeeks), 2),
      samples: matches.length,
    });
  }

  return points;
}

/**
 * Grade a forecast against what happened.
 *
 * MAPE is the number the industry quotes, but it divides by actuals and so
 * explodes on a quiet interval — one contact forecast where none arrived is a
 * 100% error, and a night shift of those makes any forecast look worthless.
 * Weighted MAPE is reported alongside it and is the one worth acting on.
 */
export function forecastAccuracy(
  predicted: { startsAt: Date; volume: number }[],
  actual: { startsAt: Date; volume: number }[],
): { mape: number; weightedMape: number; bias: number; intervals: number } {
  const actualByTime = new Map(actual.map((entry) => [entry.startsAt.getTime(), entry.volume]));

  let absoluteError = 0;
  let actualTotal = 0;
  let percentageSum = 0;
  let scored = 0;
  let signedError = 0;

  for (const point of predicted) {
    const observed = actualByTime.get(point.startsAt.getTime());
    if (observed === undefined) continue;

    absoluteError += Math.abs(point.volume - observed);
    signedError += point.volume - observed;
    actualTotal += observed;

    if (observed > 0) {
      percentageSum += Math.abs(point.volume - observed) / observed;
      scored += 1;
    }
  }

  return {
    mape: scored ? round((percentageSum / scored) * 100, 2) : 0,
    weightedMape: actualTotal ? round((absoluteError / actualTotal) * 100, 2) : 0,
    // Positive means the forecast runs hot, which over-rosters; negative
    // under-rosters, which is the expensive direction.
    bias: actualTotal ? round((signedError / actualTotal) * 100, 2) : 0,
    intervals: predicted.length,
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
