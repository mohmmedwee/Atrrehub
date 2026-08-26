import { describe, expect, it } from 'vitest';
import { REPORT_SOURCES, describeSources } from './report-sources';
import { ReportsService, type ReportResult } from './reports.service';

/**
 * The service is exercised without its dependencies: everything asserted here
 * is pure — CSV rendering, schedule arithmetic and the catalogue's shape.
 */
const service = new ReportsService(
  null as never,
  null as never,
  { error: () => {}, info: () => {}, warn: () => {}, log: () => {} } as never,
);

const result = (rows: Record<string, string | number | null>[]): ReportResult => ({
  columns: [
    { key: 'channel', label: 'Channel', type: 'dimension' },
    { key: 'count', label: 'Conversations', type: 'metric' },
  ],
  rows,
  rowCount: rows.length,
  range: { from: new Date('2026-01-01'), to: new Date('2026-02-01') },
  truncated: false,
});

describe('CSV export', () => {
  it('renders a header row and one line per row, CRLF terminated', () => {
    const csv = service.toCsv(result([{ channel: 'email', count: 12 }]));
    expect(csv).toBe('Channel,Conversations\r\nemail,12');
  });

  it('quotes values containing a comma, quote or newline', () => {
    const csv = service.toCsv(result([{ channel: 'email, web', count: 1 }]));
    expect(csv).toContain('"email, web"');
  });

  it('doubles an embedded quote rather than truncating the field', () => {
    const csv = service.toCsv(result([{ channel: 'say "hi"', count: 1 }]));
    expect(csv).toContain('"say ""hi"""');
  });

  it('neutralises a formula so a spreadsheet does not execute it', () => {
    const csv = service.toCsv(result([{ channel: '=cmd|/c calc', count: 1 }]));
    expect(csv).toContain("'=cmd|/c calc");
    expect(csv).not.toMatch(/(^|,)=cmd/);
  });

  it('writes an empty field for a null metric rather than "null"', () => {
    const csv = service.toCsv(result([{ channel: 'web_chat', count: null }]));
    expect(csv).toBe('Channel,Conversations\r\nweb_chat,');
  });
});

describe('schedule matching', () => {
  const monday7am = new Date('2026-08-24T07:00:00Z'); // a Monday

  it('fires when every field matches', () => {
    expect(service.isDue('0 7 * * 1', null, monday7am)).toBe(true);
  });

  it('does not fire on the wrong day', () => {
    expect(service.isDue('0 7 * * 2', null, monday7am)).toBe(false);
  });

  it('does not fire on the wrong hour', () => {
    expect(service.isDue('0 8 * * 1', null, monday7am)).toBe(false);
  });

  it('accepts a comma list of hours', () => {
    expect(service.isDue('0 7,19 * * *', null, monday7am)).toBe(true);
  });

  it('accepts a step interval', () => {
    expect(service.isDue('0 */7 * * *', null, monday7am)).toBe(true);
    expect(service.isDue('0 */5 * * *', null, monday7am)).toBe(false);
  });

  it('rejects an expression that is not five fields', () => {
    expect(service.isDue('0 7 * *', null, monday7am)).toBe(false);
    expect(service.isDue('every monday', null, monday7am)).toBe(false);
  });

  it('does not send twice within the same hour', () => {
    const justSent = new Date(monday7am.getTime() - 60_000);
    expect(service.isDue('0 7 * * 1', justSent, monday7am)).toBe(false);
  });

  it('sends again a week later', () => {
    const lastWeek = new Date(monday7am.getTime() - 7 * 86_400_000);
    expect(service.isDue('0 7 * * 1', lastWeek, monday7am)).toBe(true);
  });
});

describe('the report catalogue', () => {
  it('never publishes the SQL behind a dimension', () => {
    const serialized = JSON.stringify(describeSources());
    expect(serialized).not.toContain('COALESCE');
    expect(serialized).not.toContain('COUNT(*)');
  });

  it('scopes every dimension and metric to its own source alias', () => {
    for (const source of Object.values(REPORT_SOURCES)) {
      for (const [key, spec] of Object.entries(source.dimensions)) {
        expect(spec.sql, `${source.table}.${key}`).toContain(`${source.alias}.`);
      }
      for (const [key, spec] of Object.entries(source.metrics)) {
        // COUNT(*) needs no column, so only qualified references are checked.
        const references = spec.sql.match(/\b[a-z]+\.[a-z_]+\b/g) ?? [];
        for (const reference of references) {
          expect(reference.startsWith(`${source.alias}.`), `${key}: ${reference}`).toBe(true);
        }
      }
    }
  });

  it('declares a date column that exists on every source', () => {
    for (const source of Object.values(REPORT_SOURCES)) {
      expect(source.dateColumn).toMatch(/^[a-z_]+$/);
    }
  });
});
