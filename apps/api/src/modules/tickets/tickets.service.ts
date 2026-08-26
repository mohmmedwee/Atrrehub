import { Injectable } from '@nestjs/common';
import { Prisma, type TicketStatus } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId, newReference } from '../../core/ids/id.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CustomersService } from '../customers/customers.service';
import { DirectoryService } from '../directory/directory.service';
import {
  cursorArgs,
  csvFilter,
  paginate,
  parseSort,
  type CursorParams,
} from '../../common/pagination';

const OPEN_STATUSES: TicketStatus[] = ['open', 'pending', 'on_hold', 'reopened'];

/** Fields whose changes are worth recording on the ticket's own history. */
const TRACKED_FIELDS = [
  'status',
  'priority',
  'assigneeId',
  'teamId',
  'queueId',
  'category',
  'subject',
  'dueAt',
] as const;

export interface TicketInput {
  subject: string;
  description?: string;
  customerId?: string;
  conversationId?: string;
  priority?: string;
  category?: string;
  assigneeId?: string;
  teamId?: string;
  queueId?: string;
  labels?: string[];
  customFields?: Record<string, unknown>;
  source?: string;
  dueAt?: Date;
  workspaceId?: string;
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly directory: DirectoryService,
  ) {}

  static get openStatuses(): TicketStatus[] {
    return [...OPEN_STATUSES];
  }

  // ── Numbering ──────────────────────────────────────────────────────────────

  /**
   * Per-tenant sequential ticket numbers. The counter row is updated inside the
   * creating transaction, so concurrent creates serialize on that row rather
   * than racing to the same number.
   */
  private async nextNumber(tx: Prisma.TransactionClient, organizationId: string): Promise<number> {
    const counter = await tx.ticketCounter.upsert({
      where: { organizationId },
      create: { organizationId, nextNumber: 2 },
      update: { nextNumber: { increment: 1 } },
    });
    // The stored value is what the *next* ticket will take, so this one gets
    // the value immediately below it. A fresh counter is created at 2, handing
    // out 1 here.
    return counter.nextNumber - 1;
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async create(input: TicketInput) {
    const organizationId = RequestContextStore.organizationId()!;
    if (input.customFields) await this.directory.validateCustomFields('ticket', input.customFields);

    const principal = RequestContextStore.principal();
    const id = newId('ticket');

    const ticket = await this.prisma.raw.$transaction(async (tx) => {
      const number = await this.nextNumber(tx, organizationId);
      return tx.ticket.create({
        data: {
          id,
          organizationId,
          workspaceId: input.workspaceId ?? null,
          number,
          reference: `T-${String(number).padStart(5, '0')}`,
          subject: input.subject,
          description: input.description ?? null,
          status: 'open',
          priority: (input.priority ?? 'normal') as never,
          category: input.category ?? null,
          customerId: input.customerId ?? null,
          conversationId: input.conversationId ?? null,
          assigneeId: input.assigneeId ?? null,
          teamId: input.teamId ?? null,
          queueId: input.queueId ?? null,
          labels: input.labels ?? [],
          customFields: (input.customFields ?? {}) as Prisma.InputJsonValue,
          source: (input.source ?? 'api') as never,
          dueAt: input.dueAt ?? null,
          createdById: principal?.id ?? null,
        },
      });
    });

    if (input.customerId) {
      await this.customers.recordActivity(input.customerId, {
        kind: 'ticket_created',
        title: `Ticket ${ticket.reference} created`,
        summary: input.subject,
        refType: 'ticket',
        refId: id,
      });
    }

    await this.events.publish(
      DomainEvent.TicketCreated,
      { type: 'ticket', id },
      {
        ticketId: id,
        customerId: input.customerId,
        priority: ticket.priority,
      },
    );
    await this.audit.record({
      action: 'ticket.created',
      resourceType: 'ticket',
      resourceId: id,
      after: ticket,
    });
    return this.get(id);
  }

  async get(ticketId: string) {
    const ticket = await this.prisma.db.ticket.findFirst({
      where: { id: ticketId },
      include: {
        customer: {
          select: { id: true, displayName: true, avatarUrl: true, tier: true, company: true },
        },
        conversation: { select: { id: true, reference: true, channel: true, status: true } },
        _count: { select: { comments: true, attachments: true } },
      },
    });
    if (!ticket) throw AppError.notFound('Ticket', ticketId);
    return ticket;
  }

  async list(
    params: CursorParams & {
      status?: string;
      priority?: string;
      category?: string;
      assigneeId?: string;
      teamId?: string;
      queueId?: string;
      customerId?: string;
      labels?: string[];
      open?: boolean;
      overdue?: boolean;
      q?: string;
      sort?: string;
    },
  ) {
    const where: Prisma.TicketWhereInput = {
      ...(params.status
        ? {
            status: {
              in: csvFilter(params.status, [
                'open',
                'pending',
                'on_hold',
                'resolved',
                'closed',
                'reopened',
              ]) as never,
            },
          }
        : {}),
      ...(params.open ? { status: { in: OPEN_STATUSES } } : {}),
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
      ...(params.category ? { category: params.category } : {}),
      ...(params.assigneeId ? { assigneeId: params.assigneeId } : {}),
      ...(params.teamId ? { teamId: params.teamId } : {}),
      ...(params.queueId ? { queueId: params.queueId } : {}),
      ...(params.customerId ? { customerId: params.customerId } : {}),
      ...(params.labels?.length ? { labels: { hasSome: params.labels } } : {}),
      ...(params.overdue ? { dueAt: { lt: new Date() }, status: { in: OPEN_STATUSES } } : {}),
      ...(params.q
        ? {
            OR: [
              { subject: { contains: params.q, mode: 'insensitive' } },
              { description: { contains: params.q, mode: 'insensitive' } },
              { reference: { contains: params.q.toUpperCase() } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.db.ticket.findMany({
      where,
      include: { customer: { select: { id: true, displayName: true, tier: true } } },
      orderBy: parseSort(params.sort, ['createdAt', 'updatedAt', 'priority', 'dueAt', 'number']),
      ...cursorArgs(params),
    });
    return paginate(rows, params.limit);
  }

  /**
   * Update a ticket. `expectedVersion` enables optimistic locking so two agents
   * editing the same ticket cannot silently overwrite each other.
   */
  async update(
    ticketId: string,
    patch: Partial<TicketInput> & { status?: string },
    expectedVersion?: number,
  ) {
    const before = await this.get(ticketId);
    if (expectedVersion !== undefined && before.version !== expectedVersion) {
      throw AppError.versionConflict('Ticket', expectedVersion, before.version);
    }
    if (patch.customFields) await this.directory.validateCustomFields('ticket', patch.customFields);

    const now = new Date();
    const status = patch.status as TicketStatus | undefined;

    const after = await this.prisma.db.ticket.update({
      where: { id: ticketId },
      data: {
        ...(patch as Prisma.TicketUpdateInput),
        ...(patch.customFields
          ? {
              customFields: {
                ...(before.customFields as object),
                ...patch.customFields,
              } as Prisma.InputJsonValue,
            }
          : {}),
        ...(status === 'resolved' ? { resolvedAt: now } : {}),
        ...(status === 'closed' ? { closedAt: now, resolvedAt: before.resolvedAt ?? now } : {}),
        ...(status === 'reopened'
          ? { reopenCount: { increment: 1 }, resolvedAt: null, closedAt: null }
          : {}),
        version: { increment: 1 },
      } as never,
    });

    await this.recordHistory(ticketId, before as never, after as never);

    await this.events.publish(
      DomainEvent.TicketUpdated,
      { type: 'ticket', id: ticketId },
      {
        ticketId,
        changed: Object.keys(patch),
      },
    );
    if (status === 'resolved') {
      await this.events.publish(
        DomainEvent.TicketResolved,
        { type: 'ticket', id: ticketId },
        { ticketId },
      );
    }
    if (status === 'closed') {
      await this.events.publish(
        DomainEvent.TicketClosed,
        { type: 'ticket', id: ticketId },
        { ticketId },
      );
    }
    if (status === 'reopened') {
      await this.events.publish(
        DomainEvent.TicketReopened,
        { type: 'ticket', id: ticketId },
        { ticketId },
      );
    }
    if (patch.assigneeId && patch.assigneeId !== before.assigneeId) {
      await this.events.publish(
        DomainEvent.TicketAssigned,
        { type: 'ticket', id: ticketId },
        {
          ticketId,
          assigneeId: patch.assigneeId,
        },
      );
    }

    return this.get(ticketId);
  }

  async delete(ticketId: string) {
    const ticket = await this.get(ticketId);
    await this.prisma.db.ticket.delete({ where: { id: ticketId } });
    await this.audit.record({
      action: 'ticket.deleted',
      resourceType: 'ticket',
      resourceId: ticketId,
      before: ticket,
    });
  }

  /**
   * Apply one change set to many tickets. Failures are collected per ticket
   * rather than aborting the batch, because a bulk action on 200 tickets should
   * not be undone by one stale row.
   */
  async bulkUpdate(ticketIds: string[], patch: Partial<TicketInput> & { status?: string }) {
    const results = await Promise.allSettled(ticketIds.map((id) => this.update(id, patch)));
    const succeeded: string[] = [];
    const failed: { ticketId: string; reason: string }[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') succeeded.push(ticketIds[index]);
      else failed.push({ ticketId: ticketIds[index], reason: (result.reason as Error).message });
    });
    await this.audit.record({
      action: 'ticket.bulk_updated',
      resourceType: 'ticket',
      after: { count: succeeded.length, patch },
    });
    return { succeeded, failed, total: ticketIds.length };
  }

  // ── History ────────────────────────────────────────────────────────────────

  private async recordHistory(
    ticketId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ) {
    const organizationId = RequestContextStore.organizationId()!;
    const principal = RequestContextStore.principal();

    const rows = TRACKED_FIELDS.filter(
      (field) => String(before[field] ?? '') !== String(after[field] ?? ''),
    ).map((field) => ({
      id: newId('history'),
      organizationId,
      ticketId,
      actorType: (principal?.type === 'api_key' ? 'user' : (principal?.type ?? 'system')) as never,
      actorId: principal?.id ?? null,
      field,
      fromValue:
        before[field] === null || before[field] === undefined ? null : String(before[field]),
      toValue: after[field] === null || after[field] === undefined ? null : String(after[field]),
    }));
    if (rows.length) await this.prisma.raw.ticketHistory.createMany({ data: rows });
  }

  async history(ticketId: string) {
    await this.get(ticketId);
    return this.prisma.db.ticketHistory.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  async addComment(ticketId: string, body: string, isInternal = false) {
    await this.get(ticketId);
    const principal = RequestContextStore.principal();
    const comment = await this.prisma.db.ticketComment.create({
      data: {
        id: newId('comment'),
        ticketId,
        body,
        isInternal,
        authorType: (principal?.type === 'user' || principal?.type === 'api_key'
          ? 'user'
          : 'system') as never,
        authorId: principal?.id ?? null,
      } as never,
    });
    // The first public comment is the ticket's first response for SLA purposes.
    if (!isInternal) {
      await this.prisma.db.ticket.updateMany({
        where: { id: ticketId, firstResponseAt: null },
        data: { firstResponseAt: new Date() },
      });
    }
    return comment;
  }

  async listComments(ticketId: string, includeInternal = true) {
    await this.get(ticketId);
    return this.prisma.db.ticketComment.findMany({
      where: { ticketId, ...(includeInternal ? {} : { isInternal: false }) },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Templates ──────────────────────────────────────────────────────────────

  async listTemplates() {
    return this.prisma.db.ticketTemplate.findMany({ where: {}, orderBy: { name: 'asc' } });
  }

  async createTemplate(input: {
    name: string;
    subject: string;
    description?: string;
    priority?: string;
    category?: string;
    labels?: string[];
    customFields?: Record<string, unknown>;
  }) {
    return this.prisma.db.ticketTemplate.create({
      data: {
        id: newId('template'),
        name: input.name,
        subject: input.subject,
        description: input.description ?? null,
        priority: (input.priority ?? 'normal') as never,
        category: input.category ?? null,
        labels: input.labels ?? [],
        customFields: (input.customFields ?? {}) as Prisma.InputJsonValue,
      } as never,
    });
  }

  async deleteTemplate(templateId: string) {
    await this.prisma.db.ticketTemplate.delete({ where: { id: templateId } });
  }

  async createFromTemplate(templateId: string, overrides: Partial<TicketInput>) {
    const template = await this.prisma.db.ticketTemplate.findFirst({ where: { id: templateId } });
    if (!template) throw AppError.notFound('Ticket template', templateId);
    return this.create({
      subject: template.subject,
      description: template.description ?? undefined,
      priority: template.priority,
      category: template.category ?? undefined,
      labels: template.labels,
      customFields: template.customFields as Record<string, unknown>,
      ...overrides,
    });
  }

  /** Open a ticket directly from a conversation, carrying its context across. */
  async createFromConversation(conversationId: string, overrides: Partial<TicketInput> = {}) {
    const conversation = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    if (!conversation) throw AppError.notFound('Conversation', conversationId);

    return this.create({
      subject:
        overrides.subject ?? conversation.subject ?? `Conversation ${conversation.reference}`,
      description: overrides.description ?? conversation.messages[0]?.body,
      customerId: conversation.customerId ?? undefined,
      conversationId,
      priority: overrides.priority ?? conversation.priority,
      queueId: overrides.queueId ?? conversation.queueId ?? undefined,
      teamId: overrides.teamId ?? conversation.teamId ?? undefined,
      assigneeId:
        overrides.assigneeId ??
        (conversation.assigneeType === 'user' ? (conversation.assigneeId ?? undefined) : undefined),
      source: conversation.channel,
      workspaceId: conversation.workspaceId ?? undefined,
      ...overrides,
    });
  }
}
