import { Injectable } from '@nestjs/common';
import { Prisma, type RoutingStrategy } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ConversationsService } from '../conversations/conversations.service';
import { DirectoryService } from '../directory/directory.service';

export interface RoutingCandidate {
  userId: string;
  skills: string[];
  languages: string[];
  maxConcurrentChats: number;
  activeCount: number;
  presence: string;
}

/** The conversation facts a routing rule can test. */
export interface RoutingSubject {
  channel: string;
  locale: string;
  priority: string;
  customerTier?: string | null;
  tags?: string[];
  intent?: string | null;
  sentimentScore?: number | null;
}

export interface RoutingDecision {
  queueId?: string | null;
  teamId?: string | null;
  assignee?: { type: 'user' | 'ai_agent'; id: string } | null;
  strategy: RoutingStrategy;
  ruleId?: string;
  reason: string;
}

/**
 * Routing engine.
 *
 * Rules are evaluated in position order; the first whose conditions all match
 * decides the destination. Within the chosen queue a strategy selects the
 * agent — availability and capacity are always respected, so a strategy can
 * only ever choose among agents who can actually take the work.
 */
@Injectable()
export class RoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly directory: DirectoryService,
    private readonly events: EventBus,
    private readonly logger: AppLogger,
  ) {}

  // ── Rules ──────────────────────────────────────────────────────────────────

  async listRules() {
    return this.prisma.db.routingRule.findMany({ where: {}, orderBy: { position: 'asc' } });
  }

  async createRule(input: {
    name: string;
    position?: number;
    strategy?: RoutingStrategy;
    conditions?: Record<string, unknown>;
    targetQueueId?: string;
    targetTeamId?: string;
    targetUserId?: string;
    targetAgentId?: string;
    requireSkills?: string[];
  }) {
    return this.prisma.db.routingRule.create({
      data: {
        id: newId('routingRule'),
        name: input.name,
        position: input.position ?? 0,
        strategy: (input.strategy ?? 'round_robin') as never,
        conditions: (input.conditions ?? {}) as Prisma.InputJsonValue,
        targetQueueId: input.targetQueueId ?? null,
        targetTeamId: input.targetTeamId ?? null,
        targetUserId: input.targetUserId ?? null,
        targetAgentId: input.targetAgentId ?? null,
        requireSkills: input.requireSkills ?? [],
      } as never,
    });
  }

  async updateRule(ruleId: string, patch: Record<string, unknown>) {
    return this.prisma.db.routingRule.update({ where: { id: ruleId }, data: patch as never });
  }

  async deleteRule(ruleId: string) {
    await this.prisma.db.routingRule.delete({ where: { id: ruleId } });
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  /**
   * Decide where a conversation should go, then apply the decision.
   *
   * An AI-first queue routes to its agent before any human is considered, which
   * is what makes AI deflection the default path rather than an afterthought.
   */
  async route(conversationId: string): Promise<RoutingDecision> {
    const conversation = await this.conversations.get(conversationId);
    const organizationId = RequestContextStore.organizationId()!;

    const decision = await this.decide(conversation);

    await this.events.publish(
      DomainEvent.RoutingEvaluated,
      { type: 'conversation', id: conversationId },
      {
        conversationId,
        ruleId: decision.ruleId,
        strategy: decision.strategy,
      },
    );

    if (decision.assignee) {
      await this.conversations.assign(conversationId, decision.assignee, {
        reason: decision.reason,
        queueId: decision.queueId ?? undefined,
      });
      await this.events.publish(
        DomainEvent.RoutingAssigned,
        { type: 'conversation', id: conversationId },
        {
          conversationId,
          assigneeId: decision.assignee.id,
        },
      );
    } else {
      // Nobody is available: park it in the queue rather than dropping it.
      await this.prisma.db.conversation.update({
        where: { id: conversationId },
        data: {
          queueId: decision.queueId ?? conversation.queueId,
          teamId: decision.teamId ?? conversation.teamId,
          status: 'queued',
          queuedAt: new Date(),
        },
      });
      await this.events.publish(
        DomainEvent.RoutingUnassignable,
        { type: 'conversation', id: conversationId },
        {
          conversationId,
          reason: decision.reason,
        },
      );
      this.logger.debug('Conversation parked in queue', {
        conversationId,
        reason: decision.reason,
      });
    }

    void organizationId;
    return decision;
  }

  private async decide(
    conversation: Awaited<ReturnType<ConversationsService['get']>>,
  ): Promise<RoutingDecision> {
    const rules = await this.prisma.db.routingRule.findMany({
      where: { isActive: true },
      orderBy: { position: 'asc' },
    });

    const matched = rules.find((rule) =>
      this.matches(rule.conditions as Record<string, unknown>, conversation),
    );

    // Direct assignment short-circuits every other consideration.
    if (matched?.targetUserId) {
      return {
        queueId: matched.targetQueueId ?? conversation.queueId,
        teamId: matched.targetTeamId,
        assignee: { type: 'user', id: matched.targetUserId },
        strategy: 'direct',
        ruleId: matched.id,
        reason: `rule:${matched.name}`,
      };
    }
    if (matched?.targetAgentId) {
      return {
        queueId: matched.targetQueueId ?? conversation.queueId,
        assignee: { type: 'ai_agent', id: matched.targetAgentId },
        strategy: matched.strategy,
        ruleId: matched.id,
        reason: `rule:${matched.name}`,
      };
    }

    const queueId =
      matched?.targetQueueId ??
      conversation.queueId ??
      (await this.defaultQueueId(conversation.channel));
    const queue = queueId ? await this.prisma.db.queue.findFirst({ where: { id: queueId } }) : null;

    if (queue?.aiFirst && queue.aiAgentId) {
      return {
        queueId,
        teamId: queue.teamId,
        assignee: { type: 'ai_agent', id: queue.aiAgentId },
        strategy: 'ai_intent',
        ruleId: matched?.id,
        reason: 'queue:ai_first',
      };
    }

    const strategy = (matched?.strategy ?? queue?.strategy ?? 'round_robin') as RoutingStrategy;
    const requiredSkills = [...(matched?.requireSkills ?? []), ...(queue?.skills ?? [])];
    const requiredLanguages = queue?.languages?.length ? queue.languages : [conversation.locale];

    const candidates = await this.candidates({
      teamId: matched?.targetTeamId ?? queue?.teamId ?? conversation.teamId,
      skills: requiredSkills,
      languages: requiredLanguages,
      businessHoursId: queue?.businessHoursId,
    });

    if (!candidates.length) {
      return {
        queueId,
        teamId: queue?.teamId,
        assignee: null,
        strategy,
        ruleId: matched?.id,
        reason: 'no_available_agent',
      };
    }

    const chosen = await this.select(strategy, candidates, queueId);
    return {
      queueId,
      teamId: queue?.teamId,
      assignee: chosen ? { type: 'user', id: chosen.userId } : null,
      strategy,
      ruleId: matched?.id,
      reason: chosen ? `strategy:${strategy}` : 'no_available_agent',
    };
  }

  /**
   * All conditions must hold for a rule to match. An empty condition set
   * matches *nothing* rather than everything — a rule with no conditions is
   * almost always half-configured, and treating it as a catch-all would
   * silently swallow every conversation.
   *
   * Unknown condition keys also fail closed, so a typo narrows a rule out of
   * contention instead of widening it.
   */
  static matchesConditions(conditions: Record<string, unknown>, subject: RoutingSubject): boolean {
    const entries = Object.entries(conditions ?? {});
    if (!entries.length) return false;

    for (const [key, raw] of entries) {
      const expected = Array.isArray(raw) ? raw : [raw];
      switch (key) {
        case 'channel':
          if (!expected.includes(subject.channel)) return false;
          break;
        case 'language':
        case 'locale':
          if (!expected.includes(subject.locale)) return false;
          break;
        case 'priority':
          if (!expected.includes(subject.priority)) return false;
          break;
        case 'tier':
          if (!subject.customerTier || !expected.includes(subject.customerTier)) return false;
          break;
        case 'tags':
          if (!(subject.tags ?? []).some((tag) => expected.includes(tag))) return false;
          break;
        case 'intent':
          if (!subject.intent || !expected.includes(subject.intent)) return false;
          break;
        case 'sentimentBelow': {
          const score = subject.sentimentScore;
          if (score === null || score === undefined || score >= Number(raw)) return false;
          break;
        }
        default:
          return false;
      }
    }
    return true;
  }

  private matches(
    conditions: Record<string, unknown>,
    conversation: Awaited<ReturnType<ConversationsService['get']>>,
  ): boolean {
    return RoutingService.matchesConditions(conditions, {
      channel: conversation.channel,
      locale: conversation.locale,
      priority: conversation.priority,
      customerTier: conversation.customer?.tier ?? null,
      tags: conversation.tags,
      intent: conversation.intelligence?.intent ?? null,
      sentimentScore: conversation.intelligence?.sentimentScore ?? null,
    });
  }

  private async defaultQueueId(channel: string): Promise<string | null> {
    const queue =
      (await this.prisma.db.queue.findFirst({
        where: { isActive: true, channels: { has: channel as never } },
      })) ??
      (await this.prisma.db.queue.findFirst({ where: { isActive: true, key: 'general' } })) ??
      (await this.prisma.db.queue.findFirst({ where: { isActive: true } }));
    return queue?.id ?? null;
  }

  /**
   * Agents who could take this conversation right now: available, inside
   * business hours, holding the required skills and languages, and below their
   * concurrency ceiling.
   */
  async candidates(filter: {
    teamId?: string | null;
    skills?: string[];
    languages?: string[];
    businessHoursId?: string | null;
  }): Promise<RoutingCandidate[]> {
    const calendar = await this.directory.calendarFor(filter.businessHoursId);
    if (!calendar.isOpenAt(new Date())) return [];

    const memberships = await this.prisma.db.membership.findMany({
      where: {
        ...(filter.teamId
          ? { user: { teamMemberships: { some: { teamId: filter.teamId } } } }
          : {}),
        user: {
          status: 'active',
          presence: 'available',
          ...(filter.skills?.length ? { skills: { hasEvery: filter.skills } } : {}),
          ...(filter.languages?.length ? { languages: { hasSome: filter.languages } } : {}),
          ...(filter.teamId ? { teamMemberships: { some: { teamId: filter.teamId } } } : {}),
        },
      },
      include: {
        user: {
          select: {
            id: true,
            skills: true,
            languages: true,
            maxConcurrentChats: true,
            presence: true,
          },
        },
      },
    });
    if (!memberships.length) return [];

    const userIds = memberships.map((m) => m.userId);
    const loads = await this.prisma.db.conversation.groupBy({
      by: ['assigneeId'],
      where: {
        assigneeType: 'user',
        assigneeId: { in: userIds },
        status: { in: ['assigned', 'active', 'waiting'] },
      },
      _count: { _all: true },
    });
    const loadByUser = new Map(loads.map((row) => [row.assigneeId!, row._count._all]));

    return memberships
      .map((m) => ({
        userId: m.userId,
        skills: m.user.skills,
        languages: m.user.languages,
        maxConcurrentChats: m.user.maxConcurrentChats,
        activeCount: loadByUser.get(m.userId) ?? 0,
        presence: m.user.presence,
      }))
      .filter((candidate) => candidate.activeCount < candidate.maxConcurrentChats);
  }

  private async select(
    strategy: RoutingStrategy,
    candidates: RoutingCandidate[],
    queueId: string | null,
  ): Promise<RoutingCandidate | null> {
    if (!candidates.length) return null;

    switch (strategy) {
      case 'least_loaded':
      case 'skill_based':
      case 'language':
      case 'priority':
      case 'customer_tier':
      case 'ai_intent':
      case 'sentiment':
        // Every non-rotating strategy still balances load once its filter has
        // narrowed the pool — spare capacity is the tie-break that matters.
        return [...candidates].sort(
          (a, b) =>
            b.maxConcurrentChats - b.activeCount - (a.maxConcurrentChats - a.activeCount) ||
            a.userId.localeCompare(b.userId),
        )[0];

      case 'round_robin':
      case 'team':
      case 'direct':
      default:
        return this.roundRobin(candidates, queueId);
    }
  }

  /**
   * Rotation is persisted per queue, so restarts and multiple API instances
   * continue the same cycle rather than always starting from the first agent.
   */
  private async roundRobin(
    candidates: RoutingCandidate[],
    queueId: string | null,
  ): Promise<RoutingCandidate> {
    const ordered = [...candidates].sort((a, b) => a.userId.localeCompare(b.userId));
    if (!queueId) return ordered[0];

    const cursor = await this.prisma.raw.roundRobinCursor.upsert({
      where: { queueId },
      create: { id: newId('cursor'), queueId, lastIndex: 0 },
      update: { lastIndex: { increment: 1 } },
    });
    return ordered[cursor.lastIndex % ordered.length];
  }

  /**
   * Drain a queue: assign as many waiting conversations as there is capacity
   * for, oldest first. Called when an agent becomes available and on a timer.
   */
  async drainQueue(queueId: string, limit = 20): Promise<number> {
    const waiting = await this.prisma.db.conversation.findMany({
      where: { queueId, status: 'queued', assigneeType: 'none' },
      orderBy: [{ priority: 'desc' }, { queuedAt: 'asc' }],
      take: limit,
      select: { id: true },
    });

    let assigned = 0;
    for (const conversation of waiting) {
      const decision = await this.route(conversation.id);
      if (!decision.assignee) break; // Capacity is exhausted; stop trying.
      assigned += 1;
    }
    return assigned;
  }

  /** Preview a routing decision without applying it — used by the rule editor. */
  async simulate(conversationId: string): Promise<RoutingDecision> {
    const conversation = await this.conversations.get(conversationId);
    return this.decide(conversation);
  }
}
