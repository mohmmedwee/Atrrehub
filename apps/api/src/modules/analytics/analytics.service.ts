import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../../core/context/request-context';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { SlaService } from '../sla/sla.service';

export interface DateRange {
  from: Date;
  to: Date;
}

const CACHE_SECONDS = 60;

/**
 * Analytics.
 *
 * Every figure is computed from the operational tables inside the tenant scope,
 * with short-lived caching so a dashboard refresh does not re-aggregate on
 * every poll.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly sla: SlaService,
  ) {}

  private cacheKey(name: string, range: DateRange): string {
    return this.redis.key(
      RequestContextStore.organizationId(),
      'analytics',
      name,
      range.from.toISOString().slice(0, 13),
      range.to.toISOString().slice(0, 13),
    );
  }

  /** Executive dashboard: volume, resolution, AI deflection, CSAT, SLA, cost. */
  async executive(range: DateRange) {
    return this.redis.remember(this.cacheKey('executive', range), CACHE_SECONDS, async () => {
      const where = { createdAt: { gte: range.from, lte: range.to } };

      const [total, resolved, aiHandled, aiResolved, csat, slaAttainment, aiSpend, openNow] =
        await Promise.all([
          this.prisma.db.conversation.count({ where }),
          this.prisma.db.conversation.count({
            where: { ...where, status: { in: ['resolved', 'closed'] } },
          }),
          this.prisma.db.conversation.count({ where: { ...where, aiHandled: true } }),
          // AI resolution means the AI closed it without ever reaching a person.
          this.prisma.db.conversation.count({
            where: {
              ...where,
              aiHandled: true,
              status: { in: ['resolved', 'closed'] },
              assigneeType: { not: 'user' },
            },
          }),
          this.prisma.db.conversation.aggregate({
            where: { ...where, csatScore: { not: null } },
            _avg: { csatScore: true },
            _count: { csatScore: true },
          }),
          this.sla.attainment(range),
          this.prisma.db.aiUsage.aggregate({ where, _sum: { costUsd: true, totalTokens: true } }),
          this.prisma.db.conversation.count({
            where: { status: { in: ['new', 'queued', 'assigned', 'active', 'waiting'] } },
          }),
        ]);

      return {
        range,
        interactions: total,
        resolved,
        resolutionRate: percent(resolved, total),
        aiHandled,
        aiResolutionRate: percent(aiResolved, total),
        deflectionRate: percent(aiResolved, aiHandled),
        csat: {
          average: csat._avg.csatScore ? Math.round(csat._avg.csatScore * 100) / 100 : null,
          responses: csat._count.csatScore,
        },
        sla: slaAttainment,
        aiCostUsd: Math.round(Number(aiSpend._sum.costUsd ?? 0) * 10_000) / 10_000,
        aiTokens: aiSpend._sum.totalTokens ?? 0,
        openNow,
      };
    });
  }

  /** Per-agent productivity: AHT, FCR, CSAT, QA score. */
  async agentPerformance(range: DateRange) {
    return this.redis.remember(this.cacheKey('agents', range), CACHE_SECONDS, async () => {
      const conversations = await this.prisma.db.conversation.findMany({
        where: {
          createdAt: { gte: range.from, lte: range.to },
          assigneeType: 'user',
          assigneeId: { not: null },
        },
        select: {
          assigneeId: true,
          status: true,
          createdAt: true,
          assignedAt: true,
          firstResponseAt: true,
          resolvedAt: true,
          csatScore: true,
          messageCount: true,
        },
      });

      const evaluations = await this.prisma.db.qcEvaluation.findMany({
        where: { createdAt: { gte: range.from, lte: range.to }, subjectId: { not: null } },
        select: { subjectId: true, score: true },
      });

      const qaByAgent = new Map<string, number[]>();
      for (const evaluation of evaluations) {
        const key = evaluation.subjectId!;
        qaByAgent.set(key, [...(qaByAgent.get(key) ?? []), evaluation.score]);
      }

      const byAgent = new Map<
        string,
        {
          handled: number;
          resolved: number;
          handleMs: number[];
          responseMs: number[];
          csat: number[];
          oneTouch: number;
        }
      >();

      for (const conversation of conversations) {
        const key = conversation.assigneeId!;
        const entry = byAgent.get(key) ?? {
          handled: 0,
          resolved: 0,
          handleMs: [],
          responseMs: [],
          csat: [],
          oneTouch: 0,
        };
        entry.handled += 1;

        if (conversation.resolvedAt) {
          entry.resolved += 1;
          const start = conversation.assignedAt ?? conversation.createdAt;
          entry.handleMs.push(conversation.resolvedAt.getTime() - start.getTime());
          // First-contact resolution: resolved within a single agent reply.
          if (conversation.messageCount <= 2) entry.oneTouch += 1;
        }
        if (conversation.firstResponseAt) {
          entry.responseMs.push(
            conversation.firstResponseAt.getTime() - conversation.createdAt.getTime(),
          );
        }
        if (conversation.csatScore !== null) entry.csat.push(conversation.csatScore);

        byAgent.set(key, entry);
      }

      const userIds = [...byAgent.keys()];
      const users = userIds.length
        ? await this.prisma.raw.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, firstName: true, lastName: true, avatarUrl: true },
          })
        : [];
      const usersById = new Map(users.map((user) => [user.id, user]));

      return [...byAgent.entries()]
        .map(([userId, entry]) => {
          const user = usersById.get(userId);
          const qaScores = qaByAgent.get(userId) ?? [];
          return {
            userId,
            name: user ? `${user.firstName} ${user.lastName}` : userId,
            avatarUrl: user?.avatarUrl ?? null,
            handled: entry.handled,
            resolved: entry.resolved,
            resolutionRate: percent(entry.resolved, entry.handled),
            averageHandleTimeMs: average(entry.handleMs),
            averageFirstResponseMs: average(entry.responseMs),
            firstContactResolutionRate: percent(entry.oneTouch, entry.resolved),
            csat: entry.csat.length ? Math.round(average(entry.csat) * 100) / 100 : null,
            qaScore: qaScores.length ? Math.round(average(qaScores) * 10) / 10 : null,
          };
        })
        .sort((a, b) => b.handled - a.handled);
    });
  }

  /** AI dashboard: deflection, handoff, cost, tokens, latency, guardrails. */
  async aiPerformance(range: DateRange) {
    return this.redis.remember(this.cacheKey('ai', range), CACHE_SECONDS, async () => {
      const where = { createdAt: { gte: range.from, lte: range.to } };

      const [executions, usage, guardrails, retrieval, handoffs] = await Promise.all([
        this.prisma.db.execution.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
          _avg: { durationMs: true },
        }),
        this.prisma.db.aiUsage.groupBy({
          by: ['model'],
          where,
          _sum: { promptTokens: true, completionTokens: true, costUsd: true },
          _avg: { latencyMs: true },
          _count: { _all: true },
        }),
        this.prisma.db.guardrailEvent.groupBy({
          by: ['check', 'action'],
          where,
          _count: { _all: true },
        }),
        this.prisma.db.retrievalLog.aggregate({
          where,
          _avg: { latencyMs: true, topScore: true },
          _count: { _all: true },
        }),
        this.prisma.db.conversation.count({
          where: { ...where, aiHandled: true, assigneeType: 'user' },
        }),
      ]);

      const totalExecutions = executions.reduce((total, row) => total + row._count._all, 0);
      const succeeded = executions.find((row) => row.status === 'succeeded')?._count._all ?? 0;
      const failed = executions.find((row) => row.status === 'failed')?._count._all ?? 0;
      const aiConversations = await this.prisma.db.conversation.count({
        where: { ...where, aiHandled: true },
      });

      return {
        range,
        executions: {
          total: totalExecutions,
          succeeded,
          failed,
          successRate: percent(succeeded, totalExecutions),
          averageDurationMs: Math.round(
            executions.reduce(
              (total, row) => total + (row._avg.durationMs ?? 0) * row._count._all,
              0,
            ) / (totalExecutions || 1),
          ),
          byStatus: executions.map((row) => ({ status: row.status, count: row._count._all })),
        },
        handoffRate: percent(handoffs, aiConversations),
        models: usage.map((row) => ({
          model: row.model,
          calls: row._count._all,
          promptTokens: row._sum.promptTokens ?? 0,
          completionTokens: row._sum.completionTokens ?? 0,
          costUsd: Math.round(Number(row._sum.costUsd ?? 0) * 10_000) / 10_000,
          averageLatencyMs: Math.round(row._avg.latencyMs ?? 0),
        })),
        guardrails: guardrails.map((row) => ({
          check: row.check,
          action: row.action,
          count: row._count._all,
        })),
        retrieval: {
          queries: retrieval._count._all,
          averageLatencyMs: Math.round(retrieval._avg.latencyMs ?? 0),
          averageTopScore: Math.round((retrieval._avg.topScore ?? 0) * 1000) / 1000,
        },
      };
    });
  }

  /** Volume, response time and resolution by channel. */
  async channelPerformance(range: DateRange) {
    return this.redis.remember(this.cacheKey('channels', range), CACHE_SECONDS, async () => {
      const conversations = await this.prisma.db.conversation.findMany({
        where: { createdAt: { gte: range.from, lte: range.to } },
        select: {
          channel: true,
          status: true,
          createdAt: true,
          firstResponseAt: true,
          resolvedAt: true,
          csatScore: true,
        },
      });

      const byChannel = new Map<
        string,
        {
          total: number;
          resolved: number;
          responseMs: number[];
          resolveMs: number[];
          csat: number[];
        }
      >();
      for (const conversation of conversations) {
        const entry = byChannel.get(conversation.channel) ?? {
          total: 0,
          resolved: 0,
          responseMs: [],
          resolveMs: [],
          csat: [],
        };
        entry.total += 1;
        if (conversation.resolvedAt) {
          entry.resolved += 1;
          entry.resolveMs.push(
            conversation.resolvedAt.getTime() - conversation.createdAt.getTime(),
          );
        }
        if (conversation.firstResponseAt) {
          entry.responseMs.push(
            conversation.firstResponseAt.getTime() - conversation.createdAt.getTime(),
          );
        }
        if (conversation.csatScore !== null) entry.csat.push(conversation.csatScore);
        byChannel.set(conversation.channel, entry);
      }

      return [...byChannel.entries()]
        .map(([channel, entry]) => ({
          channel,
          volume: entry.total,
          resolved: entry.resolved,
          resolutionRate: percent(entry.resolved, entry.total),
          averageFirstResponseMs: average(entry.responseMs),
          averageResolutionMs: average(entry.resolveMs),
          csat: entry.csat.length ? Math.round(average(entry.csat) * 100) / 100 : null,
        }))
        .sort((a, b) => b.volume - a.volume);
    });
  }

  /** A daily time series for charting. */
  async timeSeries(
    range: DateRange,
    metric: 'conversations' | 'resolutions' | 'ai_cost' | 'messages',
  ) {
    const buckets = new Map<string, number>();
    const day = (date: Date) => date.toISOString().slice(0, 10);

    if (metric === 'ai_cost') {
      const rows = await this.prisma.db.aiUsage.findMany({
        where: { createdAt: { gte: range.from, lte: range.to } },
        select: { createdAt: true, costUsd: true },
      });
      for (const row of rows) {
        buckets.set(
          day(row.createdAt),
          (buckets.get(day(row.createdAt)) ?? 0) + Number(row.costUsd),
        );
      }
    } else if (metric === 'messages') {
      const rows = await this.prisma.db.message.findMany({
        where: { createdAt: { gte: range.from, lte: range.to } },
        select: { createdAt: true },
      });
      for (const row of rows)
        buckets.set(day(row.createdAt), (buckets.get(day(row.createdAt)) ?? 0) + 1);
    } else {
      const rows = await this.prisma.db.conversation.findMany({
        where:
          metric === 'resolutions'
            ? { resolvedAt: { gte: range.from, lte: range.to } }
            : { createdAt: { gte: range.from, lte: range.to } },
        select: { createdAt: true, resolvedAt: true },
      });
      for (const row of rows) {
        const date = metric === 'resolutions' ? row.resolvedAt! : row.createdAt;
        buckets.set(day(date), (buckets.get(day(date)) ?? 0) + 1);
      }
    }

    // Emit every day in the range, including zeros, so a chart has no gaps.
    const series: { date: string; value: number }[] = [];
    for (
      let cursor = new Date(range.from);
      cursor <= range.to;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const key = day(cursor);
      const value = buckets.get(key) ?? 0;
      series.push({
        date: key,
        value: metric === 'ai_cost' ? Math.round(value * 10_000) / 10_000 : value,
      });
    }
    return { metric, series };
  }

  /** Live operational snapshot for the supervisor wallboard. */
  async liveSnapshot() {
    const [byStatus, byQueue, agents, oldest] = await Promise.all([
      this.prisma.db.conversation.groupBy({
        by: ['status'],
        where: { status: { in: ['new', 'queued', 'assigned', 'active', 'waiting'] } },
        _count: { _all: true },
      }),
      this.prisma.db.conversation.groupBy({
        by: ['queueId'],
        where: { status: 'queued' },
        _count: { _all: true },
        _min: { queuedAt: true },
      }),
      this.prisma.db.membership.count({ where: { user: { presence: 'available' } } }),
      this.prisma.db.conversation.findFirst({
        where: { status: 'queued' },
        orderBy: { queuedAt: 'asc' },
        select: { queuedAt: true },
      }),
    ]);

    return {
      byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
      queues: byQueue.map((row) => ({
        queueId: row.queueId,
        waiting: row._count._all,
        oldestQueuedAt: row._min.queuedAt,
      })),
      availableAgents: agents,
      longestWaitMs: oldest?.queuedAt ? Date.now() - oldest.queuedAt.getTime() : 0,
    };
  }
}

function percent(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

function average(values: number[]): number {
  return values.length
    ? Math.round(values.reduce((total, value) => total + value, 0) / values.length)
    : 0;
}
