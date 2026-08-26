import { Injectable } from '@nestjs/common';
import { Prisma, type Priority, type SlaTargetType } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { MetricsService } from '../../core/metrics/metrics.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { DirectoryService } from '../directory/directory.service';

export interface SlaSubject {
  type: 'conversation' | 'ticket';
  id: string;
  priority: Priority;
  channel?: string;
  teamId?: string | null;
  queueId?: string | null;
  customerTier?: string | null;
}

/**
 * SLA management.
 *
 * Targets are expressed in *working* minutes, so every due time is computed
 * through the policy's business-hours calendar. A clock pauses while the
 * conversation is waiting on the customer — that time is theirs, not the
 * team's — and resumes when they reply.
 */
@Injectable()
export class SlaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: DirectoryService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  // ── Policies ───────────────────────────────────────────────────────────────

  async listPolicies() {
    return this.prisma.db.slaPolicy.findMany({
      where: {},
      include: { targets: { orderBy: [{ type: 'asc' }, { priority: 'asc' }] }, businessHours: { select: { id: true, name: true, timezone: true } } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async createPolicy(input: {
    name: string;
    description?: string;
    businessHoursId?: string;
    conditions?: Record<string, unknown>;
    isDefault?: boolean;
    targets: { type: SlaTargetType; priority: Priority; durationMinutes: number; warningPercent?: number; escalateToTeamId?: string; escalateToUserId?: string }[];
  }) {
    if (input.isDefault) {
      await this.prisma.db.slaPolicy.updateMany({ where: {}, data: { isDefault: false } });
    }
    const policyId = newId('slaPolicy');
    const organizationId = RequestContextStore.organizationId()!;

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.slaPolicy.create({
        data: {
          id: policyId,
          organizationId,
          name: input.name,
          description: input.description ?? null,
          businessHoursId: input.businessHoursId ?? null,
          conditions: (input.conditions ?? {}) as Prisma.InputJsonValue,
          isDefault: input.isDefault ?? false,
        },
      });
      await tx.slaTarget.createMany({
        data: input.targets.map((target) => ({
          id: newId('slaTarget'),
          organizationId,
          policyId,
          type: target.type,
          priority: target.priority,
          durationMinutes: target.durationMinutes,
          warningPercent: target.warningPercent ?? 75,
          escalateToTeamId: target.escalateToTeamId ?? null,
          escalateToUserId: target.escalateToUserId ?? null,
        })),
      });
    });

    await this.audit.record({ action: 'sla_policy.created', resourceType: 'sla_policy', resourceId: policyId, after: input });
    return this.getPolicy(policyId);
  }

  async getPolicy(policyId: string) {
    const policy = await this.prisma.db.slaPolicy.findFirst({
      where: { id: policyId },
      include: { targets: true, businessHours: true },
    });
    if (!policy) throw AppError.notFound('SLA policy', policyId);
    return policy;
  }

  async updatePolicy(policyId: string, patch: Record<string, unknown>) {
    const before = await this.getPolicy(policyId);
    if (patch.isDefault) await this.prisma.db.slaPolicy.updateMany({ where: {}, data: { isDefault: false } });
    const after = await this.prisma.db.slaPolicy.update({ where: { id: policyId }, data: patch as never });
    await this.audit.recordDiff('sla_policy.updated', 'sla_policy', policyId, before as never, after as never);
    return this.getPolicy(policyId);
  }

  async deletePolicy(policyId: string) {
    const policy = await this.getPolicy(policyId);
    if (policy.isDefault) throw AppError.conflict('The default SLA policy cannot be deleted');
    await this.prisma.db.slaPolicy.delete({ where: { id: policyId } });
  }

  /**
   * Pick the policy for a subject. The most specific matching policy wins;
   * ties are broken by name so selection is deterministic, and the default
   * policy is the fallback.
   */
  async resolvePolicy(subject: SlaSubject) {
    const policies = await this.prisma.db.slaPolicy.findMany({
      where: { isActive: true },
      include: { targets: true },
      orderBy: { name: 'asc' },
    });

    let best: (typeof policies)[number] | undefined;
    let bestScore = -1;

    for (const policy of policies) {
      const conditions = (policy.conditions ?? {}) as Record<string, unknown>;
      const keys = Object.keys(conditions);
      if (!keys.length) continue;

      let score = 0;
      let matches = true;
      for (const [key, value] of Object.entries(conditions)) {
        const actual =
          key === 'priority' ? subject.priority
          : key === 'channel' ? subject.channel
          : key === 'teamId' ? subject.teamId
          : key === 'queueId' ? subject.queueId
          : key === 'tier' ? subject.customerTier
          : undefined;
        const expected = Array.isArray(value) ? value : [value];
        if (actual === undefined || actual === null || !expected.includes(actual)) {
          matches = false;
          break;
        }
        score += 1;
      }
      if (matches && score > bestScore) {
        best = policy;
        bestScore = score;
      }
    }

    return best ?? policies.find((policy) => policy.isDefault) ?? null;
  }

  // ── Clocks ─────────────────────────────────────────────────────────────────

  /**
   * Start the SLA clocks for a subject. Existing running clocks of the same
   * type are left alone so a re-trigger cannot reset a deadline.
   */
  async startClocks(subject: SlaSubject, types: SlaTargetType[] = ['first_response', 'resolution']) {
    const policy = await this.resolvePolicy(subject);
    if (!policy) return [];

    const organizationId = RequestContextStore.organizationId()!;
    const calendar = await this.directory.calendarFor(policy.businessHoursId);
    const now = new Date();
    const created = [];

    for (const type of types) {
      const target = policy.targets.find((t) => t.type === type && t.priority === subject.priority);
      if (!target) continue;

      const existing = await this.prisma.db.slaClock.findFirst({
        where: {
          type,
          state: { in: ['running', 'paused'] },
          ...(subject.type === 'conversation' ? { conversationId: subject.id } : { ticketId: subject.id }),
        },
      });
      if (existing) continue;

      // Out of hours, the clock starts at the next opening rather than now.
      const startedAt = calendar.nextOpening(now);
      const dueAt = calendar.addWorkingMinutes(startedAt, target.durationMinutes);
      const warnAt = calendar.addWorkingMinutes(
        startedAt,
        Math.floor((target.durationMinutes * target.warningPercent) / 100),
      );

      const clock = await this.prisma.raw.slaClock.create({
        data: {
          id: newId('slaClock'),
          organizationId,
          policyId: policy.id,
          targetId: target.id,
          type,
          conversationId: subject.type === 'conversation' ? subject.id : null,
          ticketId: subject.type === 'ticket' ? subject.id : null,
          state: 'running',
          startedAt,
          dueAt,
          warnAt,
        },
      });
      created.push(clock);

      await this.events.publish(DomainEvent.SlaStarted, { type: subject.type, id: subject.id }, {
        targetType: type,
        subjectId: subject.id,
        dueAt: dueAt.toISOString(),
      });
    }

    return created;
  }

  /** Stop a clock as met, recording the working time actually consumed. */
  async completeClock(subjectType: 'conversation' | 'ticket', subjectId: string, type: SlaTargetType) {
    const clock = await this.prisma.db.slaClock.findFirst({
      where: {
        type,
        state: { in: ['running', 'paused'] },
        ...(subjectType === 'conversation' ? { conversationId: subjectId } : { ticketId: subjectId }),
      },
      include: { policy: true },
    });
    if (!clock) return null;

    const calendar = await this.directory.calendarFor(clock.policy.businessHoursId);
    const now = new Date();
    const elapsedMs = calendar.elapsedWorkingMs(clock.startedAt, now) - clock.pausedMs;
    const met = now <= clock.dueAt;

    const updated = await this.prisma.db.slaClock.update({
      where: { id: clock.id },
      data: {
        state: met ? 'met' : 'breached',
        completedAt: now,
        elapsedMs: Math.max(0, elapsedMs),
        ...(met ? {} : { breachedAt: clock.breachedAt ?? now }),
      },
    });

    await this.events.publish(met ? DomainEvent.SlaMet : DomainEvent.SlaBreached, { type: subjectType, id: subjectId }, {
      targetType: type,
      subjectId,
      elapsedMs: Math.max(0, elapsedMs),
    });
    return updated;
  }

  /**
   * Pause every running clock for a subject — used when a conversation moves to
   * `waiting`, because the delay then belongs to the customer.
   */
  async pauseClocks(subjectType: 'conversation' | 'ticket', subjectId: string) {
    const clocks = await this.prisma.db.slaClock.findMany({
      where: {
        state: 'running',
        ...(subjectType === 'conversation' ? { conversationId: subjectId } : { ticketId: subjectId }),
      },
    });
    const now = new Date();
    for (const clock of clocks) {
      await this.prisma.db.slaClock.update({
        where: { id: clock.id },
        data: { state: 'paused', pausedAt: now },
      });
    }
    return clocks.length;
  }

  /** Resume paused clocks, pushing their deadlines out by the paused duration. */
  async resumeClocks(subjectType: 'conversation' | 'ticket', subjectId: string) {
    const clocks = await this.prisma.db.slaClock.findMany({
      where: {
        state: 'paused',
        ...(subjectType === 'conversation' ? { conversationId: subjectId } : { ticketId: subjectId }),
      },
      include: { policy: true },
    });

    const now = new Date();
    for (const clock of clocks) {
      if (!clock.pausedAt) continue;
      const calendar = await this.directory.calendarFor(clock.policy.businessHoursId);
      // Only *working* time spent paused extends the deadline.
      const pausedMs = calendar.elapsedWorkingMs(clock.pausedAt, now);
      const pausedMinutes = Math.floor(pausedMs / 60_000);

      await this.prisma.db.slaClock.update({
        where: { id: clock.id },
        data: {
          state: 'running',
          pausedAt: null,
          pausedMs: clock.pausedMs + pausedMs,
          dueAt: calendar.addWorkingMinutes(clock.dueAt, pausedMinutes),
          warnAt: calendar.addWorkingMinutes(clock.warnAt, pausedMinutes),
        },
      });
    }
    return clocks.length;
  }

  async cancelClocks(subjectType: 'conversation' | 'ticket', subjectId: string) {
    await this.prisma.db.slaClock.updateMany({
      where: {
        state: { in: ['running', 'paused'] },
        ...(subjectType === 'conversation' ? { conversationId: subjectId } : { ticketId: subjectId }),
      },
      data: { state: 'cancelled', completedAt: new Date() },
    });
  }

  async clocksFor(subjectType: 'conversation' | 'ticket', subjectId: string) {
    return this.prisma.db.slaClock.findMany({
      where: subjectType === 'conversation' ? { conversationId: subjectId } : { ticketId: subjectId },
      orderBy: { startedAt: 'asc' },
    });
  }

  // ── Sweep ──────────────────────────────────────────────────────────────────

  /**
   * Emit warnings and breaches for clocks that have crossed their thresholds.
   *
   * Runs across every tenant from the worker tier under a lock, so a single
   * instance sweeps at a time and a breach is announced exactly once even
   * though delivery downstream is at-least-once.
   */
  async sweep(): Promise<{ warned: number; breached: number }> {
    const release = await this.redis.acquireLock('atr:global:sla-sweep', 60_000);
    if (!release) return { warned: 0, breached: 0 };

    try {
      const now = new Date();
      let warned = 0;
      let breached = 0;

      const dueWarnings = await this.prisma.raw.slaClock.findMany({
        where: { state: 'running', warnedAt: null, warnAt: { lte: now }, dueAt: { gt: now } },
        include: { policy: { select: { organizationId: true } } },
        take: 500,
      });

      for (const clock of dueWarnings) {
        await this.prisma.raw.slaClock.update({ where: { id: clock.id }, data: { warnedAt: now } });
        await RequestContextStore.runAsSystem(async () => {
          await this.events.publish(
            DomainEvent.SlaWarning,
            { type: clock.conversationId ? 'conversation' : 'ticket', id: (clock.conversationId ?? clock.ticketId)! },
            {
              targetType: clock.type,
              subjectId: clock.conversationId ?? clock.ticketId,
              dueAt: clock.dueAt.toISOString(),
              remainingMs: clock.dueAt.getTime() - now.getTime(),
            },
            { organizationId: clock.organizationId },
          );
        }, clock.organizationId);
        warned += 1;
      }

      const dueBreaches = await this.prisma.raw.slaClock.findMany({
        where: { state: 'running', breachedAt: null, dueAt: { lte: now } },
        include: { target: true },
        take: 500,
      });

      for (const clock of dueBreaches) {
        await this.prisma.raw.slaClock.update({
          where: { id: clock.id },
          data: { state: 'breached', breachedAt: now },
        });
        this.metrics.slaBreaches.inc({ target_type: clock.type, priority: clock.target?.priority ?? 'unknown' });

        await RequestContextStore.runAsSystem(async () => {
          await this.events.publish(
            DomainEvent.SlaBreached,
            { type: clock.conversationId ? 'conversation' : 'ticket', id: (clock.conversationId ?? clock.ticketId)! },
            {
              targetType: clock.type,
              subjectId: clock.conversationId ?? clock.ticketId,
              breachedAt: now.toISOString(),
            },
            { organizationId: clock.organizationId },
          );

          // Escalate where the target says so.
          if (clock.target?.escalateToUserId || clock.target?.escalateToTeamId) {
            await this.escalate(clock.organizationId, clock, now);
          }
        }, clock.organizationId);
        breached += 1;
      }

      if (warned || breached) this.logger.info('SLA sweep complete', { warned, breached });
      return { warned, breached };
    } finally {
      await release();
    }
  }

  private async escalate(
    organizationId: string,
    clock: { id: string; conversationId: string | null; ticketId: string | null; target: { escalateToUserId: string | null; escalateToTeamId: string | null } | null },
    now: Date,
  ) {
    const assigneeId = clock.target?.escalateToUserId;
    const teamId = clock.target?.escalateToTeamId;

    if (clock.conversationId) {
      await this.prisma.raw.conversation.update({
        where: { id: clock.conversationId },
        data: {
          priority: 'urgent',
          ...(assigneeId ? { assigneeType: 'user', assigneeId, assignedAt: now } : {}),
          ...(teamId ? { teamId } : {}),
        },
      });
    } else if (clock.ticketId) {
      await this.prisma.raw.ticket.update({
        where: { id: clock.ticketId },
        data: { priority: 'urgent', ...(assigneeId ? { assigneeId } : {}), ...(teamId ? { teamId } : {}) },
      });
    }

    await this.prisma.raw.slaClock.update({ where: { id: clock.id }, data: { escalatedAt: now } });
  }

  /** SLA attainment for the analytics dashboards. */
  async attainment(params: { from: Date; to: Date; type?: SlaTargetType }) {
    const clocks = await this.prisma.db.slaClock.findMany({
      where: {
        startedAt: { gte: params.from, lte: params.to },
        state: { in: ['met', 'breached'] },
        ...(params.type ? { type: params.type } : {}),
      },
      select: { type: true, state: true, elapsedMs: true },
    });

    const byType = new Map<string, { met: number; breached: number; totalMs: number; count: number }>();
    for (const clock of clocks) {
      const entry = byType.get(clock.type) ?? { met: 0, breached: 0, totalMs: 0, count: 0 };
      if (clock.state === 'met') entry.met += 1;
      else entry.breached += 1;
      entry.totalMs += clock.elapsedMs ?? 0;
      entry.count += 1;
      byType.set(clock.type, entry);
    }

    return [...byType.entries()].map(([type, entry]) => ({
      type,
      met: entry.met,
      breached: entry.breached,
      attainmentPercent: entry.count ? Math.round((entry.met / entry.count) * 1000) / 10 : 100,
      averageMs: entry.count ? Math.round(entry.totalMs / entry.count) : 0,
    }));
  }
}
