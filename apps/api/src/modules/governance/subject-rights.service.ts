import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { StorageService } from '../../core/storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { ERASED, ERASURE_PLAN, assertPlanIsOrdered } from './erasure-plan';

export interface ErasureResult {
  customerId: string;
  dryRun: boolean;
  /** Rows affected per model, in the order the plan runs. */
  affected: { model: string; action: string; rows: number }[];
  /** Stored objects removed — recordings and attachments. */
  objectsDeleted: number;
  completedAt: string;
}

export interface ExportResult {
  customerId: string;
  storageKey: string;
  sizeBytes: number;
  checksum: string;
  sections: Record<string, number>;
  generatedAt: string;
}

/**
 * The data subject's rights: access (export) and erasure.
 *
 * Both are deliberately in one service. They are two views of the same
 * question — what does this platform hold about this person — and letting them
 * drift apart is how an export ends up missing a table the erasure clears, or
 * worse, an erasure misses a table the export happily hands over.
 */
@Injectable()
export class SubjectRightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {
    // Fails at construction rather than during someone's erasure request.
    assertPlanIsOrdered();
  }

  // ── Right of access ────────────────────────────────────────────────────────

  /**
   * Everything the platform holds about a customer, as a JSON archive.
   *
   * Written to object storage rather than returned inline: a long-standing
   * customer's history is megabytes of transcripts, and a response body that
   * size times out somewhere between here and the person who asked for it.
   */
  async export(customerId: string): Promise<ExportResult> {
    const organizationId = RequestContextStore.organizationId()!;
    const customer = await this.loadCustomer(customerId);

    const [contactMethods, notes, activities, aiContext, conversations, tickets, calls, memory] =
      await Promise.all([
        this.prisma.db.contactMethod.findMany({ where: { customerId } }),
        this.prisma.db.customerNote.findMany({ where: { customerId } }),
        this.prisma.db.customerActivity.findMany({ where: { customerId } }),
        this.prisma.db.customerAiContext.findUnique({ where: { customerId } }),
        this.prisma.db.conversation.findMany({
          where: { customerId },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.db.ticket.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
        this.prisma.db.call.findMany({ where: { customerId }, orderBy: { startedAt: 'asc' } }),
        this.prisma.db.memoryEntry.findMany({ where: { customerId } }),
      ]);

    // Messages are fetched by conversation rather than by customer: a message
    // has no customer of its own, and fetching them any other way would quietly
    // omit every agent reply — which is part of their record too.
    const messages = conversations.length
      ? await this.prisma.db.message.findMany({
          where: { conversationId: { in: conversations.map((row) => row.id) } },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    const archive = {
      subject: { customerId, organizationId },
      generatedAt: new Date().toISOString(),
      // Named so the recipient can tell what they are looking at without
      // needing the schema in front of them.
      notice:
        'This archive contains the personal data held by Atrrehub about the subject named above, ' +
        'including messages written by support agents in conversations with them.',
      customer,
      contactMethods,
      notes,
      activities,
      aiContext,
      conversations,
      messages,
      tickets,
      calls,
      memory,
    };

    const body = Buffer.from(JSON.stringify(archive, null, 2), 'utf8');
    const stored = await this.storage.putInternal(
      exportKey(organizationId, customerId),
      body,
      'application/json',
    );

    await this.audit.record({
      action: 'governance.subject_exported',
      resourceType: 'customer',
      resourceId: customerId,
      after: { storageKey: stored.key, sizeBytes: stored.size },
    });

    return {
      customerId,
      storageKey: stored.key,
      sizeBytes: stored.size,
      checksum: stored.checksum,
      sections: {
        contactMethods: contactMethods.length,
        notes: notes.length,
        activities: activities.length,
        aiContext: aiContext ? 1 : 0,
        conversations: conversations.length,
        messages: messages.length,
        tickets: tickets.length,
        calls: calls.length,
        memory: memory.length,
      },
      generatedAt: archive.generatedAt,
    };
  }

  // ── Right to erasure ───────────────────────────────────────────────────────

  /**
   * Erase a person from the platform.
   *
   * What this replaces mattered: deleting a customer row sets
   * `conversations.customer_id` and `tickets.customer_id` to NULL — every
   * message body, subject line and voice recording stayed in the database, and
   * became unreachable, so a later erasure could not even find them. That is
   * worse than not erasing, because it looks like erasing.
   *
   * `dryRun` counts what would go without touching anything, because nobody
   * should have to find out what this does by running it.
   */
  async erase(customerId: string, options: { dryRun?: boolean } = {}): Promise<ErasureResult> {
    const dryRun = options.dryRun ?? false;
    await this.loadCustomer(customerId);

    const conversationIds = (
      await this.prisma.db.conversation.findMany({ where: { customerId }, select: { id: true } })
    ).map((row) => row.id);
    const ticketIds = (
      await this.prisma.db.ticket.findMany({ where: { customerId }, select: { id: true } })
    ).map((row) => row.id);
    const callIds = (
      await this.prisma.db.call.findMany({ where: { customerId }, select: { id: true } })
    ).map((row) => row.id);
    const messageIds = conversationIds.length
      ? (
          await this.prisma.db.message.findMany({
            where: { conversationId: { in: conversationIds } },
            select: { id: true },
          })
        ).map((row) => row.id)
      : [];

    const scope = { conversationIds, ticketIds, callIds, messageIds, customerId };
    const affected: ErasureResult['affected'] = [];
    let objectsDeleted = 0;

    // An earlier subject access request left a full archive of this person in
    // object storage. Erasing the database while that file survives is not
    // erasure — and it is the copy most likely to be forgotten, because
    // nothing in the database points at it.
    const organizationId = RequestContextStore.organizationId()!;
    const archiveKey = exportKey(organizationId, customerId);
    if (!dryRun && (await this.storage.exists(archiveKey))) {
      await this.storage.delete(archiveKey);
      objectsDeleted += 1;
    }

    for (const step of ERASURE_PLAN) {
      const rows = dryRun
        ? await this.count(step.model, scope)
        : await this.apply(step.model, step.action, step.fields ?? [], scope);
      if (step.action === 'delete_with_object' && !dryRun) objectsDeleted += rows;
      affected.push({ model: step.model, action: step.action, rows });
    }

    const result: ErasureResult = {
      customerId,
      dryRun,
      affected,
      objectsDeleted,
      completedAt: new Date().toISOString(),
    };

    if (!dryRun) {
      this.logger.info('Erased a data subject', {
        customerId,
        rows: affected.reduce((sum, entry) => sum + entry.rows, 0),
      });
      // The audit record is the one thing that survives, and must: proving an
      // erasure happened is itself a compliance obligation, and it contains no
      // personal data beyond an identifier that now refers to nothing.
      await this.audit.record({
        action: 'governance.subject_erased',
        resourceType: 'customer',
        resourceId: customerId,
        after: { affected, objectsDeleted },
      });
    }
    return result;
  }

  // ── Plan execution ─────────────────────────────────────────────────────────

  private async count(model: string, scope: Scope): Promise<number> {
    const where = this.whereFor(model, scope);
    if (!where) return 0;
    const delegate = this.delegate(model);
    return delegate.count({ where });
  }

  private async apply(
    model: string,
    action: string,
    fields: string[],
    scope: Scope,
  ): Promise<number> {
    const where = this.whereFor(model, scope);
    if (!where) return 0;
    const delegate = this.delegate(model);

    if (action === 'delete') {
      const result = await delegate.deleteMany({ where });
      return result.count;
    }

    if (action === 'delete_with_object') {
      // The rows are read first so the storage keys are known; deleting the
      // rows first would strand the objects with nothing pointing at them.
      const rows: { id: string; storageKey: string }[] = await delegate.findMany({
        where,
        select: { id: true, storageKey: true },
      });
      for (const row of rows) {
        await this.storage.delete(row.storageKey).catch((error) =>
          // A missing object is fine — it is already gone. Any other failure
          // is logged and the row is still removed: leaving the row would
          // mean the export still lists a file the subject asked us to erase.
          this.logger.warn('Could not delete a stored object during erasure', {
            storageKey: row.storageKey,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      if (rows.length) {
        await delegate.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
      }
      return rows.length;
    }

    const result = await delegate.updateMany({ where, data: this.redaction(fields) });
    return result.count;
  }

  /** The value each redacted field is overwritten with, by its shape. */
  private redaction(fields: string[]): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const field of fields) {
      if (field === 'customerId') data[field] = null;
      else if (field === 'metadata' || field === 'attributes' || field === 'customFields')
        data[field] = {};
      else if (field === 'payload') data[field] = { erased: true };
      else data[field] = ERASED;
    }
    return data;
  }

  private whereFor(model: string, scope: Scope): Record<string, unknown> | null {
    switch (model) {
      case 'customer':
        return { id: scope.customerId };
      case 'memoryEntry':
      case 'customerAiContext':
      case 'customerNote':
      case 'customerActivity':
      case 'contactMethod':
        return { customerId: scope.customerId };
      case 'conversation':
        return scope.conversationIds.length ? { id: { in: scope.conversationIds } } : null;
      case 'ticket':
        return scope.ticketIds.length ? { id: { in: scope.ticketIds } } : null;
      case 'call':
        return scope.callIds.length ? { id: { in: scope.callIds } } : null;
      case 'callRecording':
      case 'callEvent':
        return scope.callIds.length ? { callId: { in: scope.callIds } } : null;
      case 'message':
        return scope.messageIds.length ? { id: { in: scope.messageIds } } : null;
      case 'participant':
        return scope.conversationIds.length
          ? { conversationId: { in: scope.conversationIds } }
          : null;
      case 'attachment':
        // Attachments hang off both messages and tickets, and a file the
        // subject sent can be on either.
        if (!scope.messageIds.length && !scope.ticketIds.length) return null;
        return {
          OR: [
            ...(scope.messageIds.length ? [{ messageId: { in: scope.messageIds } }] : []),
            ...(scope.ticketIds.length ? [{ ticketId: { in: scope.ticketIds } }] : []),
          ],
        };
      default:
        throw new Error(`The erasure plan names a model with no scope rule: ${model}`);
    }
  }

  /**
   * The tenant-guarded delegate for a model named in the plan.
   *
   * Guarded, not raw: an erasure is a request like any other, and the one
   * operation that must never reach across a tenant boundary is the one that
   * deletes things.
   */
  private delegate(model: string): PrismaDelegate {
    const delegate = (this.prisma.db as unknown as Record<string, PrismaDelegate>)[model];
    if (!delegate?.deleteMany) throw new Error(`Unknown model in the erasure plan: ${model}`);
    return delegate;
  }

  private async loadCustomer(customerId: string) {
    const customer = await this.prisma.db.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw AppError.notFound('Customer', customerId);
    return customer;
  }
}

/**
 * One key per customer, deliberately without a timestamp.
 *
 * A fresh export each time would accumulate complete archives of a person's
 * data in object storage, each one a copy nobody is tracking and erasure cannot
 * find. Overwriting means there is exactly one, at an address the erasure knows.
 */
function exportKey(organizationId: string, customerId: string): string {
  return `org/${organizationId}/subject-exports/${customerId}.json`;
}

interface Scope {
  customerId: string;
  conversationIds: string[];
  ticketIds: string[];
  callIds: string[];
  messageIds: string[];
}

interface PrismaDelegate {
  count(args: { where: unknown }): Promise<number>;
  deleteMany(args: { where: unknown }): Promise<{ count: number }>;
  updateMany(args: { where: unknown; data: unknown }): Promise<{ count: number }>;
  findMany(args: { where: unknown; select?: unknown }): Promise<never>;
}
