import { Injectable } from '@nestjs/common';
import { Prisma, type ChannelType, type ConversationStatus } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId, newReference } from '../../core/ids/id.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CustomersService } from '../customers/customers.service';
import {
  cursorArgs,
  csvFilter,
  paginate,
  parseSort,
  type CursorParams,
} from '../../common/pagination';

/**
 * Legal conversation transitions.
 *
 * Encoding the machine rather than checking statuses ad hoc keeps every caller
 * — API, routing, AI runtime, automation — honest about the same rules.
 */
const TRANSITIONS: Record<ConversationStatus, ConversationStatus[]> = {
  new: ['queued', 'assigned', 'active', 'closed'],
  queued: ['assigned', 'active', 'resolved', 'closed'],
  assigned: ['active', 'queued', 'waiting', 'resolved', 'closed'],
  active: ['waiting', 'queued', 'assigned', 'resolved', 'closed'],
  waiting: ['active', 'assigned', 'queued', 'resolved', 'closed'],
  resolved: ['active', 'closed'],
  closed: ['active'],
};

const OPEN_STATUSES: ConversationStatus[] = ['new', 'queued', 'assigned', 'active', 'waiting'];

export interface CreateConversationInput {
  channel: ChannelType;
  customerId?: string;
  subject?: string;
  queueId?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent' | 'critical';
  locale?: string;
  tags?: string[];
  externalId?: string;
  threadKey?: string;
  channelAccountId?: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateMessageInput {
  conversationId: string;
  body: string;
  bodyHtml?: string;
  direction: 'inbound' | 'outbound' | 'internal';
  type?: 'text' | 'html' | 'attachment' | 'system' | 'note' | 'handoff' | 'card';
  authorType: 'user' | 'ai_agent' | 'system' | 'customer';
  authorId?: string;
  authorName?: string;
  externalId?: string;
  language?: string;
  citations?: unknown[];
  metadata?: Record<string, unknown>;
  isPrivate?: boolean;
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
  ) {}

  static canTransition(from: ConversationStatus, to: ConversationStatus): boolean {
    return from === to || TRANSITIONS[from].includes(to);
  }

  static get openStatuses(): ConversationStatus[] {
    return [...OPEN_STATUSES];
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async create(input: CreateConversationInput) {
    const organizationId = RequestContextStore.organizationId()!;

    // One open conversation per customer per thread: providers resend, and
    // customers reply to old emails.
    if (input.threadKey) {
      const existing = await this.prisma.db.conversation.findFirst({
        where: { threadKey: input.threadKey, status: { in: OPEN_STATUSES } },
      });
      if (existing) return this.get(existing.id);
    }

    const id = newId('conversation');
    await this.prisma.db.conversation.create({
      data: {
        id,
        reference: newReference('C'),
        channel: input.channel,
        channelAccountId: input.channelAccountId ?? null,
        externalId: input.externalId ?? null,
        threadKey: input.threadKey ?? null,
        customerId: input.customerId ?? null,
        subject: input.subject ?? null,
        status: 'new',
        priority: (input.priority ?? 'normal') as never,
        queueId: input.queueId ?? null,
        locale: input.locale ?? 'en',
        tags: input.tags ?? [],
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        workspaceId: input.workspaceId ?? null,
      } as never,
    });

    if (input.customerId) {
      await this.prisma.db.participant.create({
        data: {
          id: newId('participant'),
          conversationId: id,
          actorType: 'customer',
          actorId: input.customerId,
          role: 'requester',
        } as never,
      });
      await this.customers.recordActivity(input.customerId, {
        kind: 'conversation_started',
        title: `Conversation started on ${input.channel}`,
        summary: input.subject ?? undefined,
        refType: 'conversation',
        refId: id,
      });
    }

    await this.recordEvent(id, 'created', { channel: input.channel });
    await this.events.publish(
      DomainEvent.ConversationCreated,
      { type: 'conversation', id },
      {
        conversationId: id,
        channel: input.channel,
        customerId: input.customerId,
      },
      { organizationId },
    );

    return this.get(id);
  }

  async get(conversationId: string) {
    const conversation = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId },
      include: {
        customer: {
          include: { contactMethods: { where: { isPrimary: true }, take: 1 }, aiContext: true },
        },
        queue: { select: { id: true, name: true, key: true } },
        participants: true,
        intelligence: true,
        _count: { select: { messages: true } },
      },
    });
    if (!conversation) throw AppError.notFound('Conversation', conversationId);
    return conversation;
  }

  async list(
    params: CursorParams & {
      status?: string;
      channel?: string;
      priority?: string;
      queueId?: string;
      assigneeId?: string;
      customerId?: string;
      tags?: string[];
      unassigned?: boolean;
      q?: string;
      sort?: string;
    },
  ) {
    const where: Prisma.ConversationWhereInput = {
      ...(params.status
        ? {
            status: {
              in: csvFilter(params.status, [
                'new',
                'queued',
                'assigned',
                'active',
                'waiting',
                'resolved',
                'closed',
              ]) as never,
            },
          }
        : {}),
      ...(params.channel
        ? {
            channel: {
              in: csvFilter(params.channel, [
                'web_chat',
                'email',
                'voice',
                'whatsapp',
                'sms',
                'telegram',
                'messenger',
                'instagram',
                'teams',
                'api',
              ]) as never,
            },
          }
        : {}),
      ...(params.priority
        ? {
            priority: {
              in: csvFilter(params.priority, [
                'low',
                'normal',
                'high',
                'urgent',
                'critical',
              ]) as never,
            },
          }
        : {}),
      ...(params.queueId ? { queueId: params.queueId } : {}),
      ...(params.assigneeId ? { assigneeId: params.assigneeId } : {}),
      ...(params.customerId ? { customerId: params.customerId } : {}),
      ...(params.tags?.length ? { tags: { hasSome: params.tags } } : {}),
      ...(params.unassigned ? { assigneeType: 'none' } : {}),
      ...(params.q
        ? {
            OR: [
              { subject: { contains: params.q, mode: 'insensitive' } },
              { reference: { contains: params.q.toUpperCase() } },
              { customer: { displayName: { contains: params.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.db.conversation.findMany({
      where,
      include: {
        customer: { select: { id: true, displayName: true, avatarUrl: true, tier: true } },
        queue: { select: { id: true, name: true } },
        intelligence: { select: { sentiment: true, sentimentScore: true, intent: true } },
      },
      orderBy: parseSort(params.sort, ['createdAt', 'updatedAt', 'lastMessageAt', 'priority'], {
        lastMessageAt: 'desc',
      }),
      ...cursorArgs(params),
    });

    return paginate(rows, params.limit);
  }

  /** The signed-in agent's working set. */
  async inbox(userId: string, params: CursorParams & { status?: string }) {
    return this.list({
      ...params,
      assigneeId: userId,
      status: params.status ?? 'assigned,active,waiting',
    });
  }

  async setStatus(conversationId: string, to: ConversationStatus, reason?: string) {
    const conversation = await this.get(conversationId);
    const from = conversation.status;

    if (!ConversationsService.canTransition(from, to)) {
      throw AppError.conflict(`A conversation cannot move from ${from} to ${to}`, { from, to });
    }
    if (from === to) return conversation;

    const now = new Date();
    const updated = await this.prisma.db.conversation.update({
      where: { id: conversationId },
      data: {
        status: to,
        version: { increment: 1 },
        ...(to === 'queued' ? { queuedAt: now } : {}),
        ...(to === 'waiting' ? { waitingSince: now } : {}),
        ...(to === 'active' ? { waitingSince: null } : {}),
        ...(to === 'resolved' ? { resolvedAt: now } : {}),
        ...(to === 'closed' ? { closedAt: now, resolvedAt: conversation.resolvedAt ?? now } : {}),
      },
    });

    await this.recordEvent(conversationId, 'status_changed', { from, to, reason });
    await this.events.publish(
      DomainEvent.ConversationStatusChanged,
      { type: 'conversation', id: conversationId },
      {
        conversationId,
        from,
        to,
      },
    );

    if (to === 'resolved') {
      const principal = RequestContextStore.principal();
      await this.events.publish(
        DomainEvent.ConversationResolved,
        { type: 'conversation', id: conversationId },
        {
          conversationId,
          resolvedBy: principal?.id,
          resolutionType: reason ?? 'manual',
        },
      );
      if (conversation.customerId) {
        await this.customers.recordActivity(conversation.customerId, {
          kind: 'conversation_resolved',
          title: 'Conversation resolved',
          refType: 'conversation',
          refId: conversationId,
        });
      }
    }
    if (to === 'closed') {
      await this.events.publish(
        DomainEvent.ConversationClosed,
        { type: 'conversation', id: conversationId },
        { conversationId },
      );
    }

    return updated;
  }

  /** Assign to a human or an AI agent; `null` returns the conversation to its queue. */
  async assign(
    conversationId: string,
    assignee: { type: 'user' | 'ai_agent'; id: string } | null,
    options: { reason?: string; queueId?: string } = {},
  ) {
    const conversation = await this.get(conversationId);
    const now = new Date();

    if (assignee?.type === 'user') {
      const membership = await this.prisma.db.membership.findFirst({
        where: { userId: assignee.id },
      });
      if (!membership)
        throw AppError.badRequest('The assignee is not a member of this organization');
    }

    const updated = await this.prisma.db.conversation.update({
      where: { id: conversationId },
      data: {
        assigneeType: assignee ? assignee.type : 'none',
        assigneeId: assignee?.id ?? null,
        aiAgentId: assignee?.type === 'ai_agent' ? assignee.id : conversation.aiAgentId,
        aiHandled: assignee?.type === 'ai_agent' ? true : conversation.aiHandled,
        assignedAt: assignee ? now : null,
        status: assignee ? 'assigned' : 'queued',
        ...(options.queueId ? { queueId: options.queueId } : {}),
        ...(assignee ? {} : { queuedAt: now }),
        version: { increment: 1 },
      },
    });

    if (assignee) {
      await this.prisma.db.participant.upsert({
        where: {
          conversationId_actorType_actorId: {
            conversationId,
            actorType: assignee.type,
            actorId: assignee.id,
          },
        },
        create: {
          id: newId('participant'),
          conversationId,
          actorType: assignee.type,
          actorId: assignee.id,
          role: 'assignee',
        } as never,
        update: { leftAt: null },
      });
    }

    await this.recordEvent(conversationId, assignee ? 'assigned' : 'unassigned', {
      from: conversation.assigneeId,
      to: assignee?.id,
      reason: options.reason,
    });

    await this.events.publish(
      assignee ? DomainEvent.ConversationAssigned : DomainEvent.ConversationQueued,
      { type: 'conversation', id: conversationId },
      assignee
        ? { conversationId, assigneeId: assignee.id, assigneeType: assignee.type }
        : { conversationId, queueId: updated.queueId },
    );

    return updated;
  }

  /** Hand a conversation to another agent, team or queue, preserving history. */
  async transfer(
    conversationId: string,
    target: { userId?: string; teamId?: string; queueId?: string },
    reason?: string,
  ) {
    const conversation = await this.get(conversationId);

    if (target.userId) {
      await this.assign(conversationId, { type: 'user', id: target.userId }, { reason });
    } else {
      await this.prisma.db.conversation.update({
        where: { id: conversationId },
        data: {
          assigneeType: 'none',
          assigneeId: null,
          teamId: target.teamId ?? conversation.teamId,
          queueId: target.queueId ?? conversation.queueId,
          status: 'queued',
          queuedAt: new Date(),
          version: { increment: 1 },
        },
      });
    }

    await this.recordEvent(conversationId, 'transferred', { ...target, reason });
    await this.events.publish(
      DomainEvent.ConversationTransferred,
      { type: 'conversation', id: conversationId },
      {
        conversationId,
        from: conversation.assigneeId,
        to: target.userId ?? target.teamId ?? target.queueId,
        reason,
      },
    );
    return this.get(conversationId);
  }

  async update(
    conversationId: string,
    patch: { subject?: string; priority?: string; tags?: string[]; locale?: string },
  ) {
    const before = await this.get(conversationId);
    const after = await this.prisma.db.conversation.update({
      where: { id: conversationId },
      data: { ...patch, version: { increment: 1 } } as never,
    });
    await this.audit.recordDiff(
      'conversation.updated',
      'conversation',
      conversationId,
      before as never,
      after as never,
    );
    return after;
  }

  /** Record why an AI agent handed the conversation to a person. */
  async setHandoffReason(conversationId: string, reason: string) {
    return this.prisma.db.conversation.update({
      where: { id: conversationId },
      data: { handoffReason: reason.slice(0, 500) },
      select: { id: true, handoffReason: true },
    });
  }

  async submitCsat(conversationId: string, score: number, comment?: string) {
    return this.prisma.db.conversation.update({
      where: { id: conversationId },
      data: { csatScore: score, csatComment: comment ?? null },
      select: { id: true, csatScore: true, csatComment: true },
    });
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async addMessage(input: CreateMessageInput) {
    const conversation = await this.get(input.conversationId);
    const organizationId = RequestContextStore.organizationId()!;
    const now = new Date();

    // Providers redeliver; ingesting the same message twice would double-reply.
    if (input.externalId) {
      const duplicate = await this.prisma.db.message.findFirst({
        where: { conversationId: input.conversationId, externalId: input.externalId },
      });
      if (duplicate) return duplicate;
    }

    const isFirstAgentReply =
      input.direction === 'outbound' &&
      !conversation.firstResponseAt &&
      (input.authorType === 'user' || input.authorType === 'ai_agent');

    const [message] = await this.prisma.raw.$transaction([
      this.prisma.raw.message.create({
        data: {
          id: newId('message'),
          organizationId,
          conversationId: input.conversationId,
          externalId: input.externalId ?? null,
          direction: input.direction,
          type: (input.type ?? 'text') as never,
          authorType: input.authorType,
          authorId: input.authorId ?? null,
          authorName: input.authorName ?? null,
          body: input.body,
          bodyHtml: input.bodyHtml ?? null,
          language: input.language ?? null,
          deliveryState: input.direction === 'inbound' ? 'delivered' : 'pending',
          citations: (input.citations ?? []) as Prisma.InputJsonValue,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          isPrivate: input.isPrivate ?? input.direction === 'internal',
        },
      }),
      this.prisma.raw.conversation.update({
        where: { id: input.conversationId },
        data: {
          lastMessageAt: now,
          messageCount: { increment: 1 },
          ...(isFirstAgentReply ? { firstResponseAt: now } : {}),
          // An inbound message while waiting means the customer replied.
          ...(input.direction === 'inbound' && conversation.status === 'waiting'
            ? { status: 'active' as const, waitingSince: null }
            : {}),
          ...(input.direction === 'inbound' && conversation.status === 'new'
            ? { status: 'queued' as const, queuedAt: now }
            : {}),
        },
      }),
    ]);

    await this.events.publish(
      DomainEvent.MessageCreated,
      { type: 'message', id: message.id },
      {
        conversationId: input.conversationId,
        messageId: message.id,
        direction: input.direction,
        authorType: input.authorType,
      },
    );

    return message;
  }

  async listMessages(conversationId: string, params: CursorParams & { includePrivate?: boolean }) {
    await this.get(conversationId);
    const rows = await this.prisma.db.message.findMany({
      where: {
        conversationId,
        ...(params.includePrivate === false ? { isPrivate: false } : {}),
      },
      include: { attachments: true },
      orderBy: { createdAt: 'desc' },
      ...cursorArgs(params),
    });
    const page = paginate(rows, params.limit);
    // Return oldest-first for rendering while paginating newest-first.
    return { ...page, data: page.data.reverse() };
  }

  async updateDeliveryState(messageId: string, state: string, error?: string) {
    const message = await this.prisma.db.message.update({
      where: { id: messageId },
      data: { deliveryState: state as never, deliveryError: error ?? null },
    });
    await this.events.publish(
      DomainEvent.MessageDeliveryUpdated,
      { type: 'message', id: messageId },
      {
        messageId,
        state,
      },
    );
    return message;
  }

  async addInternalNote(conversationId: string, body: string) {
    const principal = RequestContextStore.principal();
    return this.addMessage({
      conversationId,
      body,
      direction: 'internal',
      type: 'note',
      authorType: 'user',
      authorId: principal?.id,
      isPrivate: true,
    });
  }

  // ── History ────────────────────────────────────────────────────────────────

  async recordEvent(conversationId: string, type: string, data: Record<string, unknown> = {}) {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return;
    const principal = RequestContextStore.principal();
    await this.prisma.raw.conversationEvent.create({
      data: {
        id: newId('conversationEvent'),
        organizationId,
        conversationId,
        type,
        actorType: (principal?.type === 'api_key'
          ? 'user'
          : (principal?.type ?? 'system')) as never,
        actorId: principal?.id ?? null,
        data: data as Prisma.InputJsonValue,
      },
    });
  }

  async history(conversationId: string) {
    await this.get(conversationId);
    return this.prisma.db.conversationEvent.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Live queue depth and wait times, for the supervisor view. */
  async queueStats() {
    const grouped = await this.prisma.db.conversation.groupBy({
      by: ['queueId', 'status'],
      where: { status: { in: OPEN_STATUSES } },
      _count: { _all: true },
      _min: { queuedAt: true },
    });

    const byQueue = new Map<
      string,
      {
        queueId: string;
        total: number;
        byStatus: Record<string, number>;
        oldestQueuedAt: Date | null;
      }
    >();
    for (const row of grouped) {
      const key = row.queueId ?? 'unassigned';
      const entry = byQueue.get(key) ?? {
        queueId: key,
        total: 0,
        byStatus: {},
        oldestQueuedAt: null,
      };
      entry.total += row._count._all;
      entry.byStatus[row.status] = row._count._all;
      if (
        row._min.queuedAt &&
        (!entry.oldestQueuedAt || row._min.queuedAt < entry.oldestQueuedAt)
      ) {
        entry.oldestQueuedAt = row._min.queuedAt;
      }
      byQueue.set(key, entry);
    }
    return [...byQueue.values()];
  }
}
