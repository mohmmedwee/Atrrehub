import { describe, expect, it } from 'vitest';
import {
  MONTHS_AHEAD,
  PARTITIONED_TABLES,
  expiredPartitions,
  isManagedPartitionName,
  partitionFor,
  requiredPartitions,
} from './partitions';

const TABLE = PARTITIONED_TABLES[0];
const MARCH = new Date('2026-03-15T12:00:00Z');

describe('partitionFor', () => {
  it('names and bounds a month', () => {
    expect(partitionFor('api_request_logs', MARCH)).toEqual({
      name: 'api_request_logs_2026_03',
      from: '2026-03-01',
      to: '2026-04-01',
    });
  });

  it('rolls over the year at December', () => {
    expect(partitionFor('t', new Date('2026-12-20T00:00:00Z'))).toEqual({
      name: 't_2026_12',
      from: '2026-12-01',
      to: '2027-01-01',
    });
  });

  it('zero-pads single-digit months so the names sort', () => {
    expect(partitionFor('t', new Date('2026-01-05T00:00:00Z')).name).toBe('t_2026_01');
  });

  it('is stable anywhere within the month', () => {
    const first = partitionFor('t', new Date('2026-03-01T00:00:00Z'));
    const last = partitionFor('t', new Date('2026-03-31T23:59:59Z'));
    expect(first).toEqual(last);
  });
});

describe('requiredPartitions', () => {
  it('covers the retention window and the months ahead, with no gap', () => {
    const specs = requiredPartitions(TABLE, MARCH);
    expect(specs).toHaveLength(TABLE.retentionMonths + MONTHS_AHEAD + 1);

    // A gap is not a missing file — it is an insert with nowhere to go.
    for (let index = 1; index < specs.length; index += 1) {
      expect(specs[index].from).toBe(specs[index - 1].to);
    }
  });

  it('starts in the past, not at today', () => {
    const specs = requiredPartitions(TABLE, MARCH);
    expect(specs[0].from < '2026-03-01').toBe(true);
  });

  it('reaches far enough ahead that a month boundary is never a cliff', () => {
    // Created two months early: a job that only ever created "next month"
    // would fail every insert if it missed a single run at month end.
    const specs = requiredPartitions(TABLE, MARCH);
    expect(specs.at(-1)?.from).toBe('2026-05-01');
  });
});

describe('expiredPartitions', () => {
  const existing = [
    { name: 'api_request_logs_2025_10', upperBound: '2025-11-01' },
    { name: 'api_request_logs_2025_11', upperBound: '2025-12-01' },
    { name: 'api_request_logs_2025_12', upperBound: '2026-01-01' },
    { name: 'api_request_logs_2026_01', upperBound: '2026-02-01' },
    { name: 'api_request_logs_2026_03', upperBound: '2026-04-01' },
  ];

  it('drops only what is entirely outside the retention window', () => {
    // Three months' retention from March means December onward is kept.
    expect(expiredPartitions(TABLE, existing, MARCH)).toEqual([
      'api_request_logs_2025_10',
      'api_request_logs_2025_11',
    ]);
  });

  it('never drops the current month', () => {
    expect(expiredPartitions(TABLE, existing, MARCH)).not.toContain('api_request_logs_2026_03');
  });

  it('ignores a partition whose bound it cannot read', () => {
    // A partition someone attached by hand with a different scheme is left
    // alone rather than dropped on a name match.
    expect(
      expiredPartitions(TABLE, [{ name: 'legacy_archive', upperBound: 'not a date' }], MARCH),
    ).toEqual([]);
  });

  it('drops nothing when everything is current', () => {
    expect(expiredPartitions(TABLE, existing.slice(3), MARCH)).toEqual([]);
  });
});

describe('isManagedPartitionName', () => {
  it('recognises only the names this module generates', () => {
    expect(isManagedPartitionName('api_request_logs', 'api_request_logs_2026_03')).toBe(true);
    expect(isManagedPartitionName('api_request_logs', 'api_request_logs')).toBe(false);
    expect(isManagedPartitionName('api_request_logs', 'api_request_logs_2026')).toBe(false);
    expect(isManagedPartitionName('api_request_logs', 'audit_events_2026_03')).toBe(false);
    expect(isManagedPartitionName('api_request_logs', 'api_request_logs_old')).toBe(false);
  });
});
