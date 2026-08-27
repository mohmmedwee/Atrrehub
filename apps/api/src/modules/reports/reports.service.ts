import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { MailService } from '../../core/mail/mail.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import {
  DATE_BUCKETS,
  REPORT_SOURCES,
  describeSources,
  type DateBucket,
  type ReportSource,
} from './report-sources';

export type FilterOperator = 'is' | 'is_not' | 'in' | 'not_in' | 'is_set' | 'is_not_set';

export interface ReportFilter {
  field: string;
  operator: FilterOperator;
  value?: string | string[] | boolean;
}

export interface ReportDefinition {
  source: string;
  metrics: string[];
  dimensions?: string[];
  /** Buckets the source's own date column; combines with dimensions. */
  bucket?: DateBucket;
  filters?: ReportFilter[];
  range?: { from?: string; to?: string; lastDays?: number };
  sort?: { column: string; direction: 'asc' | 'desc' };
  limit?: number;
}

export interface ReportInput {
  name: string;
  description?: string;
  definition: ReportDefinition;
  visualization?: string;
  scheduleCron?: string | null;
  recipients?: string[];
  format?: 'csv' | 'json';
}

export interface ReportResult {
  columns: { key: string; label: string; type: 'dimension' | 'metric' }[];
  rows: Record<string, string | number | null>[];
  rowCount: number;
  range: { from: Date; to: Date };
  truncated: boolean;
}

/** A report is a dashboard query, not an export pipeline. */
const MAX_ROWS = 5_000;
const DEFAULT_ROWS = 500;
const DEFAULT_LAST_DAYS = 30;

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Where a report's *data* is fetched from.
   *
   * Only the query that produces the rows — a report is a snapshot of a past
   * window by definition, so replication lag is invisible in it, and a large
   * export should never compete with live traffic.
   *
   * Saved-report CRUD deliberately stays on the primary. Those are writes and
   * read-after-writes: routing them at a replica would fail outright on a
   * read-only standby, and succeed misleadingly on one that is merely stale.
   */
  private get read() {
    return this.prisma.readOnly();
  }

  catalogue() {
    return describeSources();
  }

  // ── Saved reports ──────────────────────────────────────────────────────────

  async list() {
    return this.prisma.db.savedReport.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  async get(reportId: string) {
    const report = await this.prisma.db.savedReport.findFirst({ where: { id: reportId } });
    if (!report) throw AppError.notFound('Report', reportId);
    return report;
  }

  async create(input: ReportInput) {
    this.validate(input.definition);
    this.validateSchedule(input);

    const organizationId = RequestContextStore.organizationId()!;
    const existing = await this.prisma.db.savedReport.findFirst({
      where: { name: input.name },
      select: { id: true },
    });
    if (existing) throw AppError.conflict(`A report named "${input.name}" already exists`);

    return this.prisma.db.savedReport.create({
      data: {
        id: newId('report'),
        organizationId,
        name: input.name,
        description: input.description,
        definition: input.definition as object,
        visualization: input.visualization ?? 'table',
        scheduleCron: input.scheduleCron ?? null,
        recipients: input.recipients ?? [],
        format: input.format ?? 'csv',
        createdById: RequestContextStore.principal()?.id,
      },
    });
  }

  async update(reportId: string, patch: Partial<ReportInput>) {
    const report = await this.get(reportId);
    if (patch.definition) this.validate(patch.definition);
    this.validateSchedule({
      scheduleCron: patch.scheduleCron ?? report.scheduleCron,
      recipients: patch.recipients ?? report.recipients,
    });

    return this.prisma.db.savedReport.update({
      where: { id: reportId },
      data: {
        name: patch.name,
        description: patch.description,
        definition: patch.definition as object | undefined,
        visualization: patch.visualization,
        scheduleCron: patch.scheduleCron,
        recipients: patch.recipients,
        format: patch.format,
      },
    });
  }

  async delete(reportId: string) {
    await this.get(reportId);
    await this.prisma.db.savedReport.delete({ where: { id: reportId } });
  }

  async runSaved(reportId: string, overrides?: Partial<ReportDefinition>): Promise<ReportResult> {
    const report = await this.get(reportId);
    const definition = { ...(report.definition as unknown as ReportDefinition), ...overrides };
    const result = await this.run(definition);

    await this.prisma.db.savedReport.update({
      where: { id: reportId },
      data: { lastRunAt: new Date() },
    });
    return result;
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  /**
   * Build and execute the query.
   *
   * Every identifier comes from the catalogue; every caller-supplied value is a
   * bound parameter. The organization predicate is added here rather than by
   * the tenant guard, which does not see raw SQL — so it is the first thing in
   * the WHERE clause and is never conditional.
   */
  async run(definition: ReportDefinition): Promise<ReportResult> {
    const source = this.validate(definition);
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId)
      throw AppError.badRequest('A report can only be run inside an organization');

    const range = this.resolveRange(definition.range);
    const params: unknown[] = [organizationId, range.from, range.to];
    const where: string[] = [
      `${source.alias}.organization_id = $1`,
      `${source.alias}.${source.dateColumn} >= $2`,
      `${source.alias}.${source.dateColumn} < $3`,
    ];

    for (const filter of definition.filters ?? []) {
      const spec = source.filters[filter.field];
      where.push(this.filterSql(spec.column, filter, params));
    }

    const groupBy: { key: string; label: string; sql: string }[] = [];
    if (definition.bucket) {
      params.push(definition.bucket);
      groupBy.push({
        key: 'period',
        label: 'Period',
        sql: `DATE_TRUNC($${params.length}, ${source.alias}.${source.dateColumn})`,
      });
    }
    for (const key of definition.dimensions ?? []) {
      const spec = source.dimensions[key];
      groupBy.push({ key, label: spec.label, sql: spec.sql });
    }

    const metrics = definition.metrics.map((key) => ({ key, ...source.metrics[key] }));
    const select = [
      ...groupBy.map((entry, index) => `${entry.sql} AS "d${index}"`),
      ...metrics.map((metric, index) => `${metric.sql} AS "m${index}"`),
    ].join(', ');

    const limit = Math.min(definition.limit ?? DEFAULT_ROWS, MAX_ROWS);
    const orderBy = this.orderSql(definition.sort, groupBy, metrics);

    const sql = [
      `SELECT ${select}`,
      `FROM ${source.table} ${source.alias}`,
      `WHERE ${where.join(' AND ')}`,
      groupBy.length ? `GROUP BY ${groupBy.map((_, index) => index + 1).join(', ')}` : '',
      orderBy,
      // One row over the limit is fetched so the caller can be told the report
      // was cut short rather than quietly shown a partial answer.
      `LIMIT ${limit + 1}`,
    ]
      .filter(Boolean)
      .join('\n');

    // The one query worth keeping off the primary: it scans a reporting window
    // and can return thousands of rows. It scopes itself by organization in the
    // WHERE clause above, which is what makes the unguarded client safe here.
    const raw = await this.read.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
    const truncated = raw.length > limit;

    const rows = raw.slice(0, limit).map((row) => {
      const out: Record<string, string | number | null> = {};
      groupBy.forEach((entry, index) => {
        out[entry.key] = this.formatDimension(row[`d${index}`]);
      });
      metrics.forEach((metric, index) => {
        out[metric.key] = this.formatMetric(row[`m${index}`], metric.precision);
      });
      return out;
    });

    return {
      columns: [
        ...groupBy.map((entry) => ({
          key: entry.key,
          label: entry.label,
          type: 'dimension' as const,
        })),
        ...metrics.map((metric) => ({
          key: metric.key,
          label: metric.label,
          type: 'metric' as const,
        })),
      ],
      rows,
      rowCount: rows.length,
      range,
      truncated,
    };
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  /** RFC 4180 CSV. Values are quoted whenever quoting could matter. */
  toCsv(result: ReportResult): string {
    const escape = (value: string | number | null): string => {
      if (value === null || value === undefined) return '';
      const text = String(value);
      // A leading =, +, - or @ is executed by spreadsheet software when the file
      // is opened. Prefixing a quote neutralises it without altering the value.
      const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
    };

    const header = result.columns.map((column) => escape(column.label)).join(',');
    const body = result.rows.map((row) =>
      result.columns.map((column) => escape(row[column.key] ?? null)).join(','),
    );
    return [header, ...body].join('\r\n');
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  /**
   * Run every report whose schedule is due and email the result.
   *
   * Called by the worker tier once an hour, so a schedule is honoured to the
   * hour. `lastRunAt` is the guard against a double send when two workers wake
   * together — a report already run this hour is skipped.
   */
  async dispatchScheduled(now = new Date()): Promise<number> {
    const reports = await this.prisma.raw.savedReport.findMany({
      where: { scheduleCron: { not: null }, NOT: { recipients: { isEmpty: true } } },
    });

    let sent = 0;
    for (const report of reports) {
      if (!this.isDue(report.scheduleCron!, report.lastRunAt, now)) continue;

      try {
        await RequestContextStore.runAsSystem(async () => {
          const result = await this.run(report.definition as unknown as ReportDefinition);
          const csv = this.toCsv(result);
          const stamp = now.toISOString().slice(0, 10);

          await this.mail.send({
            to: report.recipients,
            subject: `${report.name} — ${stamp}`,
            text: [
              `${report.name}`,
              report.description ?? '',
              '',
              `${result.rowCount} row(s) covering ${result.range.from.toISOString().slice(0, 10)} to ${result.range.to.toISOString().slice(0, 10)}.`,
              result.truncated ? 'The report was truncated at its row limit.' : '',
            ]
              .filter(Boolean)
              .join('\n'),
            attachments: [
              {
                filename: `${report.name.replace(/[^\w.-]+/g, '_')}-${stamp}.csv`,
                content: Buffer.from(csv, 'utf8'),
                contentType: 'text/csv; charset=utf-8',
              },
            ],
          });

          await this.prisma.raw.savedReport.update({
            where: { id: report.id },
            data: { lastRunAt: now },
          });
        }, report.organizationId);
        sent += 1;
      } catch (error) {
        this.logger.error('Scheduled report failed', error, { reportId: report.id });
      }
    }

    return sent;
  }

  /**
   * Whether a schedule is due.
   *
   * Deliberately a small subset of cron — minute, hour, day-of-month,
   * month, day-of-week with `*`, a number, or a comma list — because a report
   * schedule is chosen in a dropdown, and a full cron parser here would be
   * surface area with no user behind it.
   */
  isDue(expression: string, lastRunAt: Date | null, now: Date): boolean {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return false;

    const matches = (field: string, value: number): boolean =>
      field === '*' ||
      field.split(',').some((part) => {
        const step = part.match(/^\*\/(\d+)$/);
        if (step) return value % Number(step[1]) === 0;
        return Number(part) === value;
      });

    const due =
      matches(fields[0], now.getUTCMinutes()) &&
      matches(fields[1], now.getUTCHours()) &&
      matches(fields[2], now.getUTCDate()) &&
      matches(fields[3], now.getUTCMonth() + 1) &&
      matches(fields[4], now.getUTCDay());
    if (!due) return false;

    // The sweep runs more often than the finest schedule, so a report is only
    // sent once per matching hour however many times the sweep sees it.
    if (!lastRunAt) return true;
    return now.getTime() - lastRunAt.getTime() >= 3_600_000;
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  /** Rejects anything not in the catalogue, so nothing unknown reaches SQL. */
  private validate(definition: ReportDefinition): ReportSource {
    const source = REPORT_SOURCES[definition.source];
    if (!source)
      throw AppError.badRequest(
        `Unknown report source "${definition.source}". Available: ${Object.keys(REPORT_SOURCES).join(', ')}`,
      );

    if (!definition.metrics?.length)
      throw AppError.badRequest('A report needs at least one metric');
    for (const metric of definition.metrics) {
      if (!source.metrics[metric])
        throw AppError.badRequest(
          `"${metric}" is not a metric of ${source.label}. Available: ${Object.keys(source.metrics).join(', ')}`,
        );
    }
    for (const dimension of definition.dimensions ?? []) {
      if (!source.dimensions[dimension])
        throw AppError.badRequest(
          `"${dimension}" is not a dimension of ${source.label}. Available: ${Object.keys(source.dimensions).join(', ')}`,
        );
    }
    if (definition.bucket && !DATE_BUCKETS.includes(definition.bucket))
      throw AppError.badRequest(`"${definition.bucket}" is not a period. Use day, week or month.`);

    for (const filter of definition.filters ?? []) {
      const spec = source.filters[filter.field];
      if (!spec)
        throw AppError.badRequest(
          `"${filter.field}" cannot be filtered on ${source.label}. Available: ${Object.keys(source.filters).join(', ')}`,
        );
      if (spec.values && filter.value !== undefined) {
        const supplied = Array.isArray(filter.value) ? filter.value : [filter.value];
        const unknown = supplied.filter((value) => !spec.values!.includes(String(value)));
        if (unknown.length)
          throw AppError.badRequest(
            `${spec.label} has no value ${unknown.map((value) => `"${value}"`).join(', ')}`,
          );
      }
    }

    if (definition.sort) {
      const sortable = [
        ...Object.keys(source.metrics),
        ...Object.keys(source.dimensions),
        'period',
      ];
      if (!sortable.includes(definition.sort.column))
        throw AppError.badRequest(`"${definition.sort.column}" is not a sortable column`);
    }

    return source;
  }

  private validateSchedule(input: { scheduleCron?: string | null; recipients?: string[] }): void {
    if (!input.scheduleCron) return;
    if (input.scheduleCron.trim().split(/\s+/).length !== 5)
      throw AppError.badRequest(
        'A schedule is five cron fields: minute hour day-of-month month day-of-week',
      );
    if (!input.recipients?.length)
      throw AppError.badRequest('A scheduled report needs at least one recipient');
  }

  private filterSql(column: string, filter: ReportFilter, params: unknown[]): string {
    switch (filter.operator) {
      case 'is_set':
        return `${column} IS NOT NULL`;
      case 'is_not_set':
        return `${column} IS NULL`;
      case 'in':
      case 'not_in': {
        const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).map(String);
        if (!values.length) throw AppError.badRequest('An "in" filter needs at least one value');
        params.push(values);
        return `${column}::text ${filter.operator === 'in' ? '=' : '<>'} ANY($${params.length}::text[])`;
      }
      case 'is':
      case 'is_not': {
        if (filter.value === undefined || filter.value === null)
          throw AppError.badRequest(`A "${filter.operator}" filter needs a value`);
        params.push(String(filter.value));
        return `${column}::text ${filter.operator === 'is' ? '=' : '<>'} $${params.length}`;
      }
      default:
        throw AppError.badRequest(`Unsupported filter operator "${filter.operator}"`);
    }
  }

  private orderSql(
    sort: ReportDefinition['sort'],
    groupBy: { key: string }[],
    metrics: { key: string }[],
  ): string {
    if (!groupBy.length && !sort) return '';

    const direction = sort?.direction === 'asc' ? 'ASC' : 'DESC';
    if (sort) {
      const dimensionIndex = groupBy.findIndex((entry) => entry.key === sort.column);
      if (dimensionIndex >= 0) return `ORDER BY "d${dimensionIndex}" ${direction}`;
      const metricIndex = metrics.findIndex((metric) => metric.key === sort.column);
      if (metricIndex >= 0) return `ORDER BY "m${metricIndex}" ${direction} NULLS LAST`;
    }

    // Unsorted reports read best largest-first, except a time series, which
    // reads as a sequence and belongs in chronological order.
    if (groupBy[0]?.key === 'period') return 'ORDER BY "d0" ASC';
    return metrics.length ? 'ORDER BY "m0" DESC NULLS LAST' : '';
  }

  private resolveRange(range: ReportDefinition['range']): { from: Date; to: Date } {
    const to = range?.to ? new Date(range.to) : new Date();
    const from = range?.from
      ? new Date(range.from)
      : new Date(to.getTime() - (range?.lastDays ?? DEFAULT_LAST_DAYS) * 86_400_000);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
      throw AppError.badRequest('The report range is not a valid date range');
    if (from >= to) throw AppError.badRequest('The report range starts after it ends');

    return { from, to };
  }

  private formatDimension(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
  }

  private formatMetric(value: unknown, precision: number): number | null {
    if (value === null || value === undefined) return null;
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return null;
    const factor = 10 ** precision;
    return Math.round(numeric * factor) / factor;
  }
}
