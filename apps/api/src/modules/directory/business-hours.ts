import { DateTime, Interval } from 'luxon';

export interface BusinessHoursRule {
  /** 0 = Sunday … 6 = Saturday, matching JavaScript's getDay(). */
  day: number;
  /** `HH:mm` in the calendar's own timezone. */
  start: string;
  end: string;
}

export interface BusinessCalendar {
  timezone: string;
  rules: BusinessHoursRule[];
  /** Dates the business is closed, as `YYYY-MM-DD` in the calendar timezone. */
  holidays: string[];
}

/**
 * Business-hours arithmetic for SLA clocks.
 *
 * SLA durations are expressed in *working* minutes, so a 4-hour resolution
 * target opened at 16:00 on a Friday is due at 11:00 on Monday, not 20:00 on
 * Friday. All arithmetic happens in the calendar's timezone so daylight-saving
 * transitions are handled by the calendar rather than by minute counting.
 */
export class BusinessHoursCalculator {
  private readonly holidaySet: Set<string>;

  constructor(private readonly calendar: BusinessCalendar) {
    this.holidaySet = new Set(calendar.holidays);
  }

  /** A calendar with no rules is treated as 24×7 — the safe default for SLAs. */
  private get isAlwaysOpen(): boolean {
    return this.calendar.rules.length === 0;
  }

  isOpenAt(instant: Date): boolean {
    if (this.isAlwaysOpen) return true;
    const local = DateTime.fromJSDate(instant, { zone: this.calendar.timezone });
    if (this.holidaySet.has(local.toFormat('yyyy-MM-dd'))) return false;
    return this.rulesFor(local).some((rule) => {
      const [open, close] = this.windowFor(local, rule);
      return local >= open && local < close;
    });
  }

  /** Working milliseconds between two instants. */
  elapsedWorkingMs(from: Date, to: Date): number {
    if (to <= from) return 0;
    if (this.isAlwaysOpen) return to.getTime() - from.getTime();

    const zone = this.calendar.timezone;
    const start = DateTime.fromJSDate(from, { zone });
    const end = DateTime.fromJSDate(to, { zone });
    const span = Interval.fromDateTimes(start, end);

    let total = 0;
    let cursor = start.startOf('day');
    // Bounded so a corrupt input cannot spin: two years of working days is ample.
    for (
      let guard = 0;
      cursor <= end && guard < 800;
      guard += 1, cursor = cursor.plus({ days: 1 })
    ) {
      for (const window of this.windowsOn(cursor)) {
        const overlap = span.intersection(window);
        if (overlap) total += overlap.toDuration().toMillis();
      }
    }
    return total;
  }

  /** The instant at which `workingMinutes` of open time will have elapsed. */
  addWorkingMinutes(from: Date, workingMinutes: number): Date {
    if (workingMinutes <= 0) return from;
    if (this.isAlwaysOpen) return new Date(from.getTime() + workingMinutes * 60_000);

    const zone = this.calendar.timezone;
    const start = DateTime.fromJSDate(from, { zone });
    let remaining = workingMinutes * 60_000;
    let cursor = start.startOf('day');

    for (let guard = 0; guard < 800; guard += 1, cursor = cursor.plus({ days: 1 })) {
      for (const window of this.windowsOn(cursor)) {
        // Never count time before the starting instant.
        const from_ = window.start > start ? window.start : start;
        if (from_ >= window.end) continue;
        const available = window.end.diff(from_).toMillis();
        if (available >= remaining) {
          return from_.plus({ milliseconds: remaining }).toJSDate();
        }
        remaining -= available;
      }
    }

    // Fall back to wall-clock rather than returning nothing at all.
    return new Date(from.getTime() + workingMinutes * 60_000);
  }

  /** The next instant the business is open, or the input if it already is. */
  nextOpening(from: Date): Date {
    if (this.isAlwaysOpen || this.isOpenAt(from)) return from;
    const zone = this.calendar.timezone;
    const start = DateTime.fromJSDate(from, { zone });
    let cursor = start.startOf('day');
    for (let guard = 0; guard < 800; guard += 1, cursor = cursor.plus({ days: 1 })) {
      for (const window of this.windowsOn(cursor)) {
        if (window.start >= start) return window.start.toJSDate();
      }
    }
    return from;
  }

  private windowsOn(day: DateTime): Interval<true>[] {
    if (this.holidaySet.has(day.toFormat('yyyy-MM-dd'))) return [];
    const windows: Interval<true>[] = [];
    for (const rule of this.rulesFor(day)) {
      const [open, close] = this.windowFor(day, rule);
      if (close <= open) continue;
      const interval = Interval.fromDateTimes(open, close);
      if (interval.isValid) windows.push(interval);
    }
    return windows;
  }

  private rulesFor(instant: DateTime): BusinessHoursRule[] {
    // Luxon weekdays are 1 (Monday) … 7 (Sunday); the stored rules use 0 (Sunday) … 6.
    const day = instant.weekday % 7;
    return this.calendar.rules.filter((rule) => rule.day === day);
  }

  private windowFor(day: DateTime, rule: BusinessHoursRule): [DateTime, DateTime] {
    const [openHour, openMinute] = rule.start.split(':').map(Number);
    const [closeHour, closeMinute] = rule.end.split(':').map(Number);
    return [
      day.set({ hour: openHour, minute: openMinute, second: 0, millisecond: 0 }),
      day.set({ hour: closeHour, minute: closeMinute, second: 0, millisecond: 0 }),
    ];
  }
}
