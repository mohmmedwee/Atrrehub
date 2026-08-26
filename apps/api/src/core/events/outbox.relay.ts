import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../context/request-context';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { DomainEventEnvelope } from './domain-events';
import { EventBus } from './event-bus.service';

const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 10;

/**
 * Moves committed outbox rows onto the event bus. Runs on the worker tier under
 * a distributed lock so exactly one instance drains the outbox at a time, while
 * consumers remain idempotent because delivery is still at-least-once.
 */
@Injectable()
export class OutboxRelay {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly eventBus: EventBus,
    private readonly logger: AppLogger,
  ) {}

  async drain(): Promise<number> {
    const release = await this.redis.acquireLock('atr:global:outbox-relay', 30_000);
    if (!release) return 0;

    try {
      const pending = await this.prisma.raw.outboxEvent.findMany({
        where: { status: 'pending', attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { occurredAt: 'asc' },
        take: BATCH_SIZE,
      });
      if (!pending.length) return 0;

      let delivered = 0;
      for (const event of pending) {
        const envelope: DomainEventEnvelope = {
          id: event.id,
          type: event.type,
          version: event.version,
          occurredAt: event.occurredAt.toISOString(),
          organizationId: event.organizationId,
          workspaceId: event.workspaceId ?? undefined,
          actor: { type: event.actorType, id: event.actorId ?? undefined },
          subject: { type: event.subjectType, id: event.subjectId },
          correlationId: event.correlationId ?? undefined,
          causationId: event.causationId ?? undefined,
          data: (event.data ?? {}) as Record<string, unknown>,
        };

        try {
          // Listeners run inside the owning tenant's context so any database
          // work they do is correctly scoped.
          await RequestContextStore.runAsSystem(
            async () => this.eventBus.emitLocal(envelope),
            event.organizationId,
          );
          await this.prisma.raw.outboxEvent.update({
            where: { id: event.id },
            data: { status: 'published', publishedAt: new Date(), attempts: { increment: 1 } },
          });
          delivered += 1;
        } catch (error) {
          const attempts = event.attempts + 1;
          this.logger.error('Outbox delivery failed', error, {
            eventId: event.id,
            type: event.type,
            attempts,
          });
          await this.prisma.raw.outboxEvent.update({
            where: { id: event.id },
            data: {
              attempts,
              lastError: error instanceof Error ? error.message : String(error),
              status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            },
          });
        }
      }
      return delivered;
    } finally {
      await release();
    }
  }

  /** Rows that exhausted their retries and need operator attention. */
  async deadLettered(limit = 50) {
    return this.prisma.raw.outboxEvent.findMany({
      where: { status: 'failed' },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
  }
}
