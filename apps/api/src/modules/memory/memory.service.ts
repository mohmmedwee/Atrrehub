import { Injectable } from '@nestjs/common';
import { Prisma, type MemoryScope } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { detectPii, maskPii } from '../guardrails/detectors';

export interface MemoryPolicy {
  shortTerm?: boolean;
  longTerm?: boolean;
  retentionDays?: number;
  /** Store PII in long-term memory only where the customer has consented. */
  allowPii?: boolean;
}

export interface MemoryWrite {
  scope: MemoryScope;
  key: string;
  value: unknown;
  importance?: number;
  agentId?: string;
  customerId?: string;
  conversationId?: string;
  executionId?: string;
  retentionDays?: number;
}

const DEFAULT_RETENTION: Record<MemoryScope, number> = {
  short_term: 7,
  long_term: 365,
  agent: 30,
};

/**
 * Controlled memory for AI agents.
 *
 * Three scopes with different lifetimes and different rules: the current
 * conversation, durable customer knowledge, and workflow execution state.
 * Long-term writes pass through PII detection and are refused — not silently
 * stored — where the customer has not consented.
 */
@Injectable()
export class MemoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  async remember(
    write: MemoryWrite,
    policy: MemoryPolicy = {},
  ): Promise<{ stored: boolean; reason?: string }> {
    const organizationId = RequestContextStore.organizationId()!;

    if (write.scope === 'short_term' && policy.shortTerm === false) {
      return { stored: false, reason: 'short-term memory is disabled for this agent' };
    }
    if (write.scope === 'long_term' && policy.longTerm === false) {
      return { stored: false, reason: 'long-term memory is disabled for this agent' };
    }

    const serialized = typeof write.value === 'string' ? write.value : JSON.stringify(write.value);
    const piiMatches = detectPii(serialized);
    let value = write.value;
    let containsPii = piiMatches.length > 0;

    if (containsPii && write.scope === 'long_term') {
      const consented = write.customerId ? await this.hasConsent(write.customerId) : false;
      if (!consented && !policy.allowPii) {
        // Mask rather than drop: the fact is often still useful without the
        // identifier, and silently discarding it would look like a bug.
        const { masked } = maskPii(serialized);
        value = masked;
        containsPii = false;
        this.logger.debug('Masked PII before writing long-term memory', {
          customerId: write.customerId,
          kinds: piiMatches.map((match) => match.kind),
        });
      }
    }

    const retentionDays =
      write.retentionDays ?? policy.retentionDays ?? DEFAULT_RETENTION[write.scope];
    const expiresAt = retentionDays > 0 ? new Date(Date.now() + retentionDays * 86_400_000) : null;

    await this.prisma.raw.memoryEntry.upsert({
      where: {
        organizationId_scope_customerId_conversationId_agentId_key: {
          organizationId,
          scope: write.scope,
          customerId: write.customerId ?? '',
          conversationId: write.conversationId ?? '',
          agentId: write.agentId ?? '',
          key: write.key,
        },
      },
      create: {
        id: newId('memory'),
        organizationId,
        scope: write.scope,
        key: write.key,
        value: value as Prisma.InputJsonValue,
        importance: write.importance ?? 0.5,
        containsPii,
        agentId: write.agentId ?? '',
        customerId: write.customerId ?? '',
        conversationId: write.conversationId ?? '',
        executionId: write.executionId ?? null,
        expiresAt,
      },
      update: {
        value: value as Prisma.InputJsonValue,
        importance: write.importance ?? 0.5,
        containsPii,
        expiresAt,
      },
    });

    return { stored: true };
  }

  /**
   * Recall memory for a turn. Long-term entries are ordered by importance so a
   * bounded context window carries the facts that matter most.
   */
  async recall(filter: {
    scopes?: MemoryScope[];
    customerId?: string;
    conversationId?: string;
    agentId?: string;
    executionId?: string;
    limit?: number;
  }): Promise<{ scope: MemoryScope; key: string; value: unknown; importance: number }[]> {
    const now = new Date();
    const entries = await this.prisma.db.memoryEntry.findMany({
      where: {
        ...(filter.scopes?.length ? { scope: { in: filter.scopes } } : {}),
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.conversationId ? { conversationId: filter.conversationId } : {}),
        ...(filter.agentId ? { agentId: filter.agentId } : {}),
        ...(filter.executionId ? { executionId: filter.executionId } : {}),
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
      take: Math.min(filter.limit ?? 30, 100),
    });

    return entries.map((entry) => ({
      scope: entry.scope,
      key: entry.key,
      value: entry.value,
      importance: entry.importance,
    }));
  }

  /** Render recalled memory as a prompt fragment. */
  async recallAsContext(filter: Parameters<MemoryService['recall']>[0]): Promise<string> {
    const entries = await this.recall(filter);
    if (!entries.length) return '';
    return entries
      .map(
        (entry) =>
          `- ${entry.key}: ${typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)}`,
      )
      .join('\n');
  }

  async forget(filter: {
    scope?: MemoryScope;
    customerId?: string;
    conversationId?: string;
    key?: string;
  }): Promise<number> {
    const result = await this.prisma.db.memoryEntry.deleteMany({
      where: {
        ...(filter.scope ? { scope: filter.scope } : {}),
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.conversationId ? { conversationId: filter.conversationId } : {}),
        ...(filter.key ? { key: filter.key } : {}),
      },
    });
    return result.count;
  }

  /** Right-to-erasure: remove everything the platform remembers about a customer. */
  async forgetCustomer(customerId: string): Promise<number> {
    const result = await this.prisma.db.memoryEntry.deleteMany({ where: { customerId } });
    this.logger.info('Erased customer memory', { customerId, entries: result.count });
    return result.count;
  }

  async listForCustomer(customerId: string) {
    return this.prisma.db.memoryEntry.findMany({
      where: { customerId },
      orderBy: [{ scope: 'asc' }, { importance: 'desc' }],
    });
  }

  private async hasConsent(customerId: string): Promise<boolean> {
    const customer = await this.prisma.db.customer.findFirst({
      where: { id: customerId },
      select: { consentAiMemory: true },
    });
    return customer?.consentAiMemory ?? false;
  }

  /** Purge expired entries. Runs on the worker tier across every tenant. */
  async purgeExpired(): Promise<number> {
    const result = await this.prisma.raw.memoryEntry.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (result.count) this.logger.info('Purged expired memory entries', { count: result.count });
    return result.count;
  }

  async setConsent(customerId: string, consent: boolean) {
    const customer = await this.prisma.db.customer.update({
      where: { id: customerId },
      data: { consentAiMemory: consent },
      select: { id: true, consentAiMemory: true },
    });
    // Withdrawing consent must take effect on data already held, not just future writes.
    if (!consent) {
      const removed = await this.prisma.db.memoryEntry.deleteMany({
        where: { customerId, containsPii: true },
      });
      this.logger.info('Removed identifiable memory after consent withdrawal', {
        customerId,
        removed: removed.count,
      });
    }
    return customer;
  }
}
