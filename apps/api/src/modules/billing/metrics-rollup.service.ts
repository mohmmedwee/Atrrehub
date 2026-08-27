import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../../core/context/request-context';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * Daily analytics rollups.
 *
 * Analytics computes live from operational tables, which is right for a
 * dashboard covering the last week and wrong for one covering the last year:
 * the query cost grows with history, and retention deletes the rows the
 * historical numbers were made of. `metrics_daily` is the durable answer —
 * the table existed with nothing writing to it.
 *
 * Rolling up yesterday rather than today is deliberate: a day that is still
 * running produces a number that keeps changing, and a chart that rewrites its
 * own history is one nobody trusts.
 */

interface MetricDefinition {
  metric: string;
  dimension: string;
  sql: (organizationId: string, from: Date, to: Date) => { text: string; values: unknown[] };
}

const DEFINITIONS: MetricDefinition[] = [
  {
    metric: 'conversations.created',
    dimension: 'channel',
    sql: (organizationId, from, to) => ({
      text: `select channel::text as dimension_value, count(*)::float as value, count(*)::int as count
               from conversations
              where organization_id = $1 and created_at >= $2 and created_at < $3
              group by 1`,
      values: [organizationId, from, to],
    }),
  },
  {
    metric: 'conversations.resolved',
    dimension: 'channel',
    sql: (organizationId, from, to) => ({
      text: `select channel::text as dimension_value, count(*)::float as value, count(*)::int as count
               from conversations
              where organization_id = $1 and resolved_at >= $2 and resolved_at < $3
              group by 1`,
      values: [organizationId, from, to],
    }),
  },
  {
    metric: 'conversations.resolution_minutes',
    dimension: 'channel',
    sql: (organizationId, from, to) => ({
      text: `select channel::text as dimension_value,
                    avg(extract(epoch from (resolved_at - created_at)) / 60)::float as value,
                    count(*)::int as count
               from conversations
              where organization_id = $1 and resolved_at >= $2 and resolved_at < $3
              group by 1`,
      values: [organizationId, from, to],
    }),
  },
  {
    metric: 'messages.created',
    dimension: 'direction',
    sql: (organizationId, from, to) => ({
      text: `select direction::text as dimension_value, count(*)::float as value, count(*)::int as count
               from messages
              where organization_id = $1 and created_at >= $2 and created_at < $3
              group by 1`,
      values: [organizationId, from, to],
    }),
  },
  {
    metric: 'ai.tokens',
    dimension: 'model',
    sql: (organizationId, from, to) => ({
      text: `select coalesce(model, 'unknown') as dimension_value,
                    sum(prompt_tokens + completion_tokens)::float as value,
                    count(*)::int as count
               from ai_usage
              where organization_id = $1 and created_at >= $2 and created_at < $3
              group by 1`,
      values: [organizationId, from, to],
    }),
  },
  {
    metric: 'ai.cost_usd',
    dimension: 'model',
    sql: (organizationId, from, to) => ({
      text: `select coalesce(model, 'unknown') as dimension_value,
                    sum(cost_usd)::float as value, count(*)::int as count
               from ai_usage
              where organization_id = $1 and created_at >= $2 and created_at < $3
              group by 1`,
      values: [organizationId, from, to],
    }),
  },
  {
    metric: 'calls.handled',
    dimension: 'disposition',
    sql: (organizationId, from, to) => ({
      text: `select coalesce(disposition::text, 'unknown') as dimension_value,
                    count(*)::float as value, count(*)::int as count
               from calls
              where organization_id = $1 and started_at >= $2 and started_at < $3
              group by 1`,
      values: [organizationId, from, to],
    }),
  },
];

@Injectable()
export class MetricsRollupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  /** Roll up one day for one tenant. Idempotent, so a re-run repairs a gap. */
  async rollupDay(organizationId: string, day: Date): Promise<number> {
    const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const to = new Date(from.getTime() + 86_400_000);

    let written = 0;
    for (const definition of DEFINITIONS) {
      const { text, values } = definition.sql(organizationId, from, to);

      const rows = await this.prisma.raw.$queryRawUnsafe<
        { dimension_value: string; value: number | null; count: number }[]
      >(text, ...values);

      for (const row of rows) {
        await this.prisma.raw.metricDaily.upsert({
          where: {
            organizationId_date_metric_dimension_dimensionValue: {
              organizationId,
              date: from,
              metric: definition.metric,
              dimension: definition.dimension,
              dimensionValue: row.dimension_value ?? 'unknown',
            },
          },
          create: {
            id: newId('metric'),
            organizationId,
            date: from,
            metric: definition.metric,
            dimension: definition.dimension,
            dimensionValue: row.dimension_value ?? 'unknown',
            value: row.value ?? 0,
            count: row.count,
          },
          update: { value: row.value ?? 0, count: row.count },
        });
        written += 1;
      }
    }

    return written;
  }

  /** Roll up yesterday for every tenant. */
  async rollupYesterday(): Promise<number> {
    const yesterday = new Date(Date.now() - 86_400_000);
    const organizations = await this.prisma.raw.organization.findMany({ select: { id: true } });

    let total = 0;
    for (const organization of organizations) {
      try {
        total += await RequestContextStore.runAsSystem(
          () => this.rollupDay(organization.id, yesterday),
          organization.id,
        );
      } catch (error) {
        this.logger.error('Metric rollup failed', error, { organizationId: organization.id });
      }
    }

    if (total) this.logger.info('Daily metrics rolled up', { rows: total });
    return total;
  }

  /**
   * Backfill a range, for a tenant whose rollups have a hole in them — a
   * deployment that was down overnight, or a metric added after the fact.
   */
  async backfill(organizationId: string, from: Date, to: Date): Promise<number> {
    let total = 0;
    for (let day = new Date(from); day < to; day = new Date(day.getTime() + 86_400_000)) {
      total += await this.rollupDay(organizationId, day);
    }
    return total;
  }

  async series(params: { metric: string; from: Date; to: Date; dimensionValue?: string }) {
    const organizationId = RequestContextStore.organizationId()!;
    return this.prisma.raw.metricDaily.findMany({
      where: {
        organizationId,
        metric: params.metric,
        date: { gte: params.from, lte: params.to },
        ...(params.dimensionValue ? { dimensionValue: params.dimensionValue } : {}),
      },
      orderBy: [{ date: 'asc' }, { dimensionValue: 'asc' }],
    });
  }

  /** The metrics that exist, so a chart builder does not have to guess. */
  catalogue() {
    return DEFINITIONS.map((definition) => ({
      metric: definition.metric,
      dimension: definition.dimension,
    }));
  }
}
