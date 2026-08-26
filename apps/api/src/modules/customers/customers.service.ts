import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DirectoryService } from '../directory/directory.service';
import { cursorArgs, paginate, parseSort, type CursorParams } from '../../common/pagination';

export interface ContactMethodInput {
  kind: 'email' | 'phone' | 'whatsapp' | 'telegram' | 'external';
  value: string;
  isPrimary?: boolean;
}

export interface CustomerInput {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  company?: string;
  jobTitle?: string;
  locale?: string;
  timezone?: string;
  tier?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
  externalId?: string;
  contactMethods?: ContactMethodInput[];
  workspaceId?: string;
}

/** Filter DSL used by segments: `{ all: [...], any: [...] }`. */
export interface SegmentCondition {
  field: string;
  op: 'eq' | 'neq' | 'contains' | 'in' | 'gt' | 'lt' | 'exists' | 'not_exists';
  value?: unknown;
}

/**
 * Customer 360 — the unified customer identity layer.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly directory: DirectoryService,
  ) {}

  /**
   * Contact values are normalized before storage so `+1 (555) 010-9999`,
   * `+15550109999` and `Ada@Example.com ` all resolve to the same customer.
   */
  static normalize(kind: string, value: string): string {
    const trimmed = value.trim();
    if (kind === 'email') return trimmed.toLowerCase();
    if (kind === 'phone' || kind === 'whatsapp' || kind === 'sms')
      return trimmed.replace(/[^\d+]/g, '');
    return trimmed.toLowerCase();
  }

  private displayNameFor(input: CustomerInput, fallback?: string): string {
    return (
      input.displayName?.trim() ||
      [input.firstName, input.lastName].filter(Boolean).join(' ').trim() ||
      fallback ||
      'Unknown customer'
    );
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async create(input: CustomerInput) {
    if (input.attributes) await this.directory.validateCustomFields('customer', input.attributes);

    const contactMethods = (input.contactMethods ?? []).map((method) => ({
      ...method,
      normalized: CustomersService.normalize(method.kind, method.value),
    }));

    // Reject up front rather than letting a unique-constraint error surface.
    for (const method of contactMethods) {
      const existing = await this.prisma.db.contactMethod.findFirst({
        where: { kind: method.kind, normalized: method.normalized },
        include: { customer: { select: { id: true, displayName: true } } },
      });
      if (existing) {
        throw AppError.conflict(
          `${method.kind} ${method.value} already belongs to another customer`,
          {
            customerId: existing.customer.id,
          },
        );
      }
    }

    const id = newId('customer');
    const customer = await this.prisma.raw.$transaction(async (tx) => {
      const organizationId = RequestContextStore.organizationId()!;
      const created = await tx.customer.create({
        data: {
          id,
          organizationId,
          workspaceId: input.workspaceId ?? null,
          externalId: input.externalId ?? null,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          displayName: this.displayNameFor(input, contactMethods[0]?.value),
          company: input.company ?? null,
          jobTitle: input.jobTitle ?? null,
          locale: input.locale ?? 'en',
          timezone: input.timezone ?? null,
          tier: input.tier ?? null,
          tags: input.tags ?? [],
          attributes: (input.attributes ?? {}) as Prisma.InputJsonValue,
        },
      });

      if (contactMethods.length) {
        await tx.contactMethod.createMany({
          data: contactMethods.map((method, index) => ({
            id: newId('contactMethod'),
            organizationId,
            customerId: id,
            kind: method.kind,
            value: method.value.trim(),
            normalized: method.normalized,
            isPrimary: method.isPrimary ?? index === 0,
          })),
        });
      }

      await tx.customerActivity.create({
        data: {
          id: newId('activity'),
          organizationId,
          customerId: id,
          kind: 'customer_created',
          title: 'Customer created',
          refType: 'customer',
          refId: id,
        },
      });

      return created;
    });

    await this.events.publish(
      DomainEvent.CustomerCreated,
      { type: 'customer', id },
      { customerId: id },
    );
    await this.audit.record({
      action: 'customer.created',
      resourceType: 'customer',
      resourceId: id,
      after: customer,
    });
    return this.get(id);
  }

  async get(customerId: string) {
    // A merged record redirects to its survivor rather than showing stale data.
    // Following the chain iteratively also makes an accidental cycle harmless.
    let id = customerId;
    for (let hop = 0; hop < 10; hop += 1) {
      const customer = await this.prisma.db.customer.findFirst({
        where: { id },
        include: {
          contactMethods: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
          aiContext: true,
          _count: { select: { conversations: true, tickets: true, notes: true } },
        },
      });
      if (!customer) throw AppError.notFound('Customer', id);
      if (!customer.mergedIntoId) return customer;
      id = customer.mergedIntoId;
    }
    throw AppError.internal(`Customer ${customerId} has a cyclic merge chain`);
  }

  async update(customerId: string, patch: Partial<CustomerInput>) {
    const before = await this.get(customerId);
    if (patch.attributes) {
      await this.directory.validateCustomFields('customer', patch.attributes);
    }

    const { contactMethods, attributes, ...rest } = patch;
    const after = await this.prisma.db.customer.update({
      where: { id: customerId },
      data: {
        ...rest,
        ...(attributes
          ? {
              attributes: {
                ...(before.attributes as object),
                ...attributes,
              } as Prisma.InputJsonValue,
            }
          : {}),
        ...(patch.firstName || patch.lastName || patch.displayName
          ? { displayName: this.displayNameFor({ ...before, ...patch } as CustomerInput) }
          : {}),
      } as never,
    });

    if (contactMethods?.length) {
      for (const method of contactMethods) await this.addContactMethod(customerId, method);
    }

    await this.events.publish(
      DomainEvent.CustomerUpdated,
      { type: 'customer', id: customerId },
      {
        customerId,
        changed: Object.keys(patch),
      },
    );
    await this.audit.recordDiff(
      'customer.updated',
      'customer',
      customerId,
      before as never,
      after as never,
    );
    return this.get(customerId);
  }

  async delete(customerId: string) {
    const customer = await this.get(customerId);
    await this.prisma.db.customer.delete({ where: { id: customerId } });
    await this.audit.record({
      action: 'customer.deleted',
      resourceType: 'customer',
      resourceId: customerId,
      before: customer,
    });
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async search(
    params: CursorParams & {
      q?: string;
      tier?: string;
      tags?: string[];
      company?: string;
      segmentId?: string;
      sort?: string;
    },
  ) {
    const where: Prisma.CustomerWhereInput = {
      mergedIntoId: null,
      ...(params.tier ? { tier: params.tier } : {}),
      ...(params.company ? { company: { contains: params.company, mode: 'insensitive' } } : {}),
      ...(params.tags?.length ? { tags: { hasSome: params.tags } } : {}),
      ...(params.q
        ? {
            OR: [
              { displayName: { contains: params.q, mode: 'insensitive' } },
              { company: { contains: params.q, mode: 'insensitive' } },
              { externalId: params.q },
              {
                contactMethods: {
                  some: { normalized: { contains: CustomersService.normalize('email', params.q) } },
                },
              },
            ],
          }
        : {}),
    };

    if (params.segmentId) {
      const segment = await this.prisma.db.segment.findFirst({ where: { id: params.segmentId } });
      if (!segment) throw AppError.notFound('Segment', params.segmentId);
      Object.assign(where, this.compileSegment(segment.definition as never));
    }

    const rows = await this.prisma.db.customer.findMany({
      where,
      include: {
        contactMethods: { where: { isPrimary: true }, take: 1 },
        aiContext: { select: { sentiment: true, riskLevel: true, intent: true } },
      },
      orderBy: parseSort(params.sort, ['createdAt', 'updatedAt', 'displayName', 'lastSeenAt']),
      ...cursorArgs(params),
    });

    return paginate(rows, params.limit);
  }

  /** Resolve a customer by contact value, creating one when nothing matches. */
  async findOrCreateByContact(
    kind: string,
    value: string,
    seed: CustomerInput = {},
  ): Promise<{ customer: Awaited<ReturnType<CustomersService['get']>>; created: boolean }> {
    const normalized = CustomersService.normalize(kind, value);
    const existing = await this.prisma.db.contactMethod.findFirst({
      where: { kind, normalized },
      select: { customerId: true },
    });
    if (existing) return { customer: await this.get(existing.customerId), created: false };

    const customer = await this.create({
      ...seed,
      contactMethods: [{ kind: kind as ContactMethodInput['kind'], value, isPrimary: true }],
    });
    return { customer, created: true };
  }

  // ── Contact methods ────────────────────────────────────────────────────────

  async addContactMethod(customerId: string, input: ContactMethodInput) {
    const normalized = CustomersService.normalize(input.kind, input.value);
    const clash = await this.prisma.db.contactMethod.findFirst({
      where: { kind: input.kind, normalized },
    });
    if (clash && clash.customerId !== customerId) {
      throw AppError.conflict(`${input.kind} ${input.value} already belongs to another customer`);
    }
    if (clash) return clash;

    if (input.isPrimary) {
      await this.prisma.db.contactMethod.updateMany({
        where: { customerId, kind: input.kind },
        data: { isPrimary: false },
      });
    }

    return this.prisma.db.contactMethod.create({
      data: {
        id: newId('contactMethod'),
        customerId,
        kind: input.kind,
        value: input.value.trim(),
        normalized,
        isPrimary: input.isPrimary ?? false,
      } as never,
    });
  }

  async removeContactMethod(customerId: string, contactMethodId: string) {
    const method = await this.prisma.db.contactMethod.findFirst({
      where: { id: contactMethodId, customerId },
    });
    if (!method) throw AppError.notFound('Contact method', contactMethodId);
    await this.prisma.db.contactMethod.delete({ where: { id: contactMethodId } });
  }

  // ── Merge ──────────────────────────────────────────────────────────────────

  /**
   * Fold `sourceId` into `targetId`. Conversations, tickets, notes, activities
   * and memory move across; contact methods move unless the target already has
   * the same value. The source is tombstoned rather than deleted so historical
   * links keep resolving.
   */
  async merge(sourceId: string, targetId: string) {
    if (sourceId === targetId) throw AppError.badRequest('A customer cannot be merged into itself');

    const [source, target] = await Promise.all([this.get(sourceId), this.get(targetId)]);
    const organizationId = RequestContextStore.organizationId()!;

    await this.prisma.raw.$transaction(async (tx) => {
      const targetKeys = new Set(
        target.contactMethods.map(
          (m: { kind: string; normalized: string }) => `${m.kind}:${m.normalized}`,
        ),
      );
      for (const method of source.contactMethods) {
        if (targetKeys.has(`${method.kind}:${method.normalized}`)) {
          await tx.contactMethod.delete({ where: { id: method.id } });
        } else {
          await tx.contactMethod.update({
            where: { id: method.id },
            data: { customerId: targetId, isPrimary: false },
          });
        }
      }

      await tx.conversation.updateMany({
        where: { customerId: sourceId },
        data: { customerId: targetId },
      });
      await tx.ticket.updateMany({
        where: { customerId: sourceId },
        data: { customerId: targetId },
      });
      await tx.customerNote.updateMany({
        where: { customerId: sourceId },
        data: { customerId: targetId },
      });
      await tx.customerActivity.updateMany({
        where: { customerId: sourceId },
        data: { customerId: targetId },
      });
      await tx.memoryEntry.updateMany({
        where: { customerId: sourceId },
        data: { customerId: targetId },
      });

      // Fill gaps on the survivor from the record being absorbed.
      await tx.customer.update({
        where: { id: targetId },
        data: {
          firstName: target.firstName ?? source.firstName,
          lastName: target.lastName ?? source.lastName,
          company: target.company ?? source.company,
          jobTitle: target.jobTitle ?? source.jobTitle,
          tier: target.tier ?? source.tier,
          externalId: target.externalId ?? source.externalId,
          tags: [...new Set([...target.tags, ...source.tags])],
          attributes: {
            ...(source.attributes as object),
            ...(target.attributes as object),
          } as Prisma.InputJsonValue,
        },
      });

      await tx.customer.update({
        where: { id: sourceId },
        data: { mergedIntoId: targetId, externalId: null },
      });

      await tx.customerActivity.create({
        data: {
          id: newId('activity'),
          organizationId,
          customerId: targetId,
          kind: 'customer_merged',
          title: 'Customer records merged',
          summary: `Merged ${source.displayName ?? sourceId} into this profile`,
          refType: 'customer',
          refId: sourceId,
        },
      });
    });

    await this.events.publish(
      DomainEvent.CustomerMerged,
      { type: 'customer', id: targetId },
      { sourceId, targetId },
    );
    await this.audit.record({
      action: 'customer.merged',
      resourceType: 'customer',
      resourceId: targetId,
      before: { sourceId },
      after: { targetId },
    });
    return this.get(targetId);
  }

  // ── Notes, timeline, activity ──────────────────────────────────────────────

  async addNote(customerId: string, body: string, isPinned = false) {
    await this.get(customerId);
    const principal = RequestContextStore.principal();
    const note = await this.prisma.db.customerNote.create({
      data: {
        id: newId('note'),
        customerId,
        body,
        isPinned,
        authorId: principal?.id ?? null,
      } as never,
    });
    await this.recordActivity(customerId, {
      kind: 'note_added',
      title: 'Note added',
      summary: body.slice(0, 160),
      refType: 'note',
      refId: note.id,
    });
    return note;
  }

  async listNotes(customerId: string) {
    return this.prisma.db.customerNote.findMany({
      where: { customerId },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async deleteNote(customerId: string, noteId: string) {
    const note = await this.prisma.db.customerNote.findFirst({ where: { id: noteId, customerId } });
    if (!note) throw AppError.notFound('Note', noteId);
    await this.prisma.db.customerNote.delete({ where: { id: noteId } });
  }

  /** Append to the unified timeline. Called by every module that touches a customer. */
  async recordActivity(
    customerId: string,
    activity: {
      kind: string;
      title: string;
      summary?: string;
      refType?: string;
      refId?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return;
    await this.prisma.raw.customerActivity.create({
      data: {
        id: newId('activity'),
        organizationId,
        customerId,
        kind: activity.kind,
        title: activity.title,
        summary: activity.summary ?? null,
        refType: activity.refType ?? null,
        refId: activity.refId ?? null,
        metadata: (activity.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async timeline(customerId: string, params: CursorParams) {
    await this.get(customerId);
    const rows = await this.prisma.db.customerActivity.findMany({
      where: { customerId },
      orderBy: { occurredAt: 'desc' },
      ...cursorArgs(params),
    });
    return paginate(rows, params.limit);
  }

  /** Everything the agent workspace shows in the Customer 360 rail. */
  async overview(customerId: string) {
    const customer = await this.get(customerId);
    const [conversations, tickets, notes, activities] = await Promise.all([
      this.prisma.db.conversation.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          reference: true,
          subject: true,
          channel: true,
          status: true,
          priority: true,
          createdAt: true,
          lastMessageAt: true,
          assigneeId: true,
          csatScore: true,
        },
      }),
      this.prisma.db.ticket.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          reference: true,
          subject: true,
          status: true,
          priority: true,
          createdAt: true,
          resolvedAt: true,
        },
      }),
      this.prisma.db.customerNote.findMany({
        where: { customerId: customer.id },
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        take: 5,
      }),
      this.prisma.db.customerActivity.findMany({
        where: { customerId: customer.id },
        orderBy: { occurredAt: 'desc' },
        take: 20,
      }),
    ]);
    return { customer, conversations, tickets, notes, activities };
  }

  // ── Segments ───────────────────────────────────────────────────────────────

  async listSegments() {
    return this.prisma.db.segment.findMany({ where: {}, orderBy: { name: 'asc' } });
  }

  async createSegment(input: { name: string; description?: string; definition: unknown }) {
    return this.prisma.db.segment.create({
      data: {
        id: newId('segment'),
        name: input.name,
        description: input.description ?? null,
        definition: input.definition as Prisma.InputJsonValue,
      } as never,
    });
  }

  async deleteSegment(segmentId: string) {
    await this.prisma.db.segment.delete({ where: { id: segmentId } });
  }

  async countSegment(segmentId: string): Promise<number> {
    const segment = await this.prisma.db.segment.findFirst({ where: { id: segmentId } });
    if (!segment) throw AppError.notFound('Segment', segmentId);
    return this.prisma.db.customer.count({
      where: { mergedIntoId: null, ...this.compileSegment(segment.definition as never) },
    });
  }

  /**
   * Compiles the segment filter DSL into a Prisma where clause. Only columns on
   * the allow-list and JSON attributes can be referenced, so a segment
   * definition can never reach into another table or another tenant.
   */
  private compileSegment(definition: {
    all?: SegmentCondition[];
    any?: SegmentCondition[];
  }): Prisma.CustomerWhereInput {
    const compile = (condition: SegmentCondition): Prisma.CustomerWhereInput | null => {
      const scalarFields = ['tier', 'company', 'locale', 'displayName', 'externalId', 'jobTitle'];

      if (condition.field === 'tags') {
        const values = Array.isArray(condition.value)
          ? (condition.value as string[])
          : [String(condition.value)];
        if (condition.op === 'in') return { tags: { hasSome: values } };
        if (condition.op === 'eq') return { tags: { hasEvery: values } };
        if (condition.op === 'neq') return { NOT: { tags: { hasSome: values } } };
        return null;
      }

      if (condition.field.startsWith('attributes.')) {
        const path = condition.field.slice('attributes.'.length).split('.');
        if (condition.op === 'exists') return { attributes: { path, not: Prisma.DbNull } };
        if (condition.op === 'not_exists') return { attributes: { path, equals: Prisma.DbNull } };
        return { attributes: { path, equals: condition.value as never } };
      }

      if (!scalarFields.includes(condition.field)) return null;
      const field = condition.field;
      switch (condition.op) {
        case 'eq':
          return { [field]: condition.value } as Prisma.CustomerWhereInput;
        case 'neq':
          return { NOT: { [field]: condition.value } } as Prisma.CustomerWhereInput;
        case 'contains':
          return {
            [field]: { contains: String(condition.value), mode: 'insensitive' },
          } as Prisma.CustomerWhereInput;
        case 'in':
          return {
            [field]: { in: (condition.value as unknown[]).map(String) },
          } as Prisma.CustomerWhereInput;
        case 'exists':
          return { NOT: { [field]: null } } as Prisma.CustomerWhereInput;
        case 'not_exists':
          return { [field]: null } as Prisma.CustomerWhereInput;
        default:
          return null;
      }
    };

    const all = (definition.all ?? []).map(compile).filter(Boolean) as Prisma.CustomerWhereInput[];
    const any = (definition.any ?? []).map(compile).filter(Boolean) as Prisma.CustomerWhereInput[];

    return {
      ...(all.length ? { AND: all } : {}),
      ...(any.length ? { OR: any } : {}),
    };
  }
}
