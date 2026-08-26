import { describe, expect, it } from 'vitest';
import { BusinessHoursCalculator } from './business-hours';

const weekdays9to5 = {
  timezone: 'UTC',
  rules: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
  holidays: [],
};

const at = (iso: string) => new Date(iso);

describe('BusinessHoursCalculator', () => {
  describe('isOpenAt', () => {
    const calc = new BusinessHoursCalculator(weekdays9to5);

    it('is open inside the window on a weekday', () => {
      // Wednesday 2026-02-11.
      expect(calc.isOpenAt(at('2026-02-11T10:00:00Z'))).toBe(true);
    });

    it('is closed before opening and after closing', () => {
      expect(calc.isOpenAt(at('2026-02-11T08:59:00Z'))).toBe(false);
      expect(calc.isOpenAt(at('2026-02-11T17:00:00Z'))).toBe(false);
    });

    it('is closed at the weekend', () => {
      // Saturday and Sunday.
      expect(calc.isOpenAt(at('2026-02-14T10:00:00Z'))).toBe(false);
      expect(calc.isOpenAt(at('2026-02-15T10:00:00Z'))).toBe(false);
    });

    it('is closed on a holiday that falls on a working day', () => {
      const withHoliday = new BusinessHoursCalculator({ ...weekdays9to5, holidays: ['2026-02-11'] });
      expect(withHoliday.isOpenAt(at('2026-02-11T10:00:00Z'))).toBe(false);
    });

    it('treats an empty rule set as always open', () => {
      const always = new BusinessHoursCalculator({ timezone: 'UTC', rules: [], holidays: [] });
      expect(always.isOpenAt(at('2026-02-15T03:00:00Z'))).toBe(true);
    });
  });

  describe('elapsedWorkingMs', () => {
    const calc = new BusinessHoursCalculator(weekdays9to5);

    it('counts only time inside the window', () => {
      // 08:00 → 10:00 on a Wednesday is one working hour.
      const ms = calc.elapsedWorkingMs(at('2026-02-11T08:00:00Z'), at('2026-02-11T10:00:00Z'));
      expect(ms).toBe(3_600_000);
    });

    it('skips the closed overnight period', () => {
      // Wednesday 16:00 → Thursday 10:00 is 1h + 1h.
      const ms = calc.elapsedWorkingMs(at('2026-02-11T16:00:00Z'), at('2026-02-12T10:00:00Z'));
      expect(ms).toBe(2 * 3_600_000);
    });

    it('skips the whole weekend', () => {
      // Friday 16:00 → Monday 10:00 is 1h + 1h.
      const ms = calc.elapsedWorkingMs(at('2026-02-13T16:00:00Z'), at('2026-02-16T10:00:00Z'));
      expect(ms).toBe(2 * 3_600_000);
    });

    it('returns zero when the range is inverted or empty', () => {
      expect(calc.elapsedWorkingMs(at('2026-02-11T10:00:00Z'), at('2026-02-11T10:00:00Z'))).toBe(0);
      expect(calc.elapsedWorkingMs(at('2026-02-11T12:00:00Z'), at('2026-02-11T10:00:00Z'))).toBe(0);
    });

    it('counts wall-clock time when always open', () => {
      const always = new BusinessHoursCalculator({ timezone: 'UTC', rules: [], holidays: [] });
      expect(always.elapsedWorkingMs(at('2026-02-14T00:00:00Z'), at('2026-02-14T02:00:00Z'))).toBe(7_200_000);
    });
  });

  describe('addWorkingMinutes', () => {
    const calc = new BusinessHoursCalculator(weekdays9to5);

    it('stays inside the same day when there is room', () => {
      const due = calc.addWorkingMinutes(at('2026-02-11T10:00:00Z'), 120);
      expect(due.toISOString()).toBe('2026-02-11T12:00:00.000Z');
    });

    it('rolls a Friday afternoon target into Monday morning', () => {
      // Friday 16:00 + 4 working hours → 1h Friday, 3h Monday → Monday 12:00.
      const due = calc.addWorkingMinutes(at('2026-02-13T16:00:00Z'), 240);
      expect(due.toISOString()).toBe('2026-02-16T12:00:00.000Z');
    });

    it('starts counting at opening when raised out of hours', () => {
      // Saturday + 60 minutes → Monday 10:00.
      const due = calc.addWorkingMinutes(at('2026-02-14T12:00:00Z'), 60);
      expect(due.toISOString()).toBe('2026-02-16T10:00:00.000Z');
    });

    it('jumps over a holiday', () => {
      const withHoliday = new BusinessHoursCalculator({ ...weekdays9to5, holidays: ['2026-02-12'] });
      // Wednesday 16:00 + 2h → 1h Wednesday, Thursday is a holiday, 1h Friday.
      const due = withHoliday.addWorkingMinutes(at('2026-02-11T16:00:00Z'), 120);
      expect(due.toISOString()).toBe('2026-02-13T10:00:00.000Z');
    });

    it('returns the input for a non-positive duration', () => {
      const from = at('2026-02-11T10:00:00Z');
      expect(calc.addWorkingMinutes(from, 0)).toBe(from);
    });

    it('respects the calendar timezone rather than UTC', () => {
      // 09:00-17:00 in Amman (UTC+3 in February) is 06:00-14:00 UTC.
      const amman = new BusinessHoursCalculator({ ...weekdays9to5, timezone: 'Asia/Amman' });
      expect(amman.isOpenAt(at('2026-02-11T07:00:00Z'))).toBe(true);
      expect(amman.isOpenAt(at('2026-02-11T15:00:00Z'))).toBe(false);
    });
  });

  describe('nextOpening', () => {
    const calc = new BusinessHoursCalculator(weekdays9to5);

    it('returns the instant unchanged when already open', () => {
      const from = at('2026-02-11T10:00:00Z');
      expect(calc.nextOpening(from)).toBe(from);
    });

    it('advances to the next opening time', () => {
      expect(calc.nextOpening(at('2026-02-14T12:00:00Z')).toISOString()).toBe('2026-02-16T09:00:00.000Z');
    });
  });
});
