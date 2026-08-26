import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';
import { RequestContextStore } from '../context/request-context';
import { newId } from '../ids/id.service';
import { AppLogger } from '../logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import type { DomainEventEnvelope, DomainEventType } from './domain-events';

export interface PublishOptions {
  /** Include to publish inside the caller's transaction — the outbox guarantee. */
  tx?: Prisma.TransactionClient;
  organizationId?: string;
  workspaceId?: string;
  causationId?: string;
}

/**
 * Domain event publication.
 *
 * Events are written to the outbox table inside the same transaction as the
 * state change that produced them, so an event exists if and only if its
 * transaction committed. The relay worker then forwards them to in-process
 * listeners and to webhook subscribers, at least once.
 *
 * In-process listeners also fire immediately for latency-sensitive consumers
 * (realtime fan-out); those are best-effort and must not carry business
 * guarantees on their own.
 */
@Injectable()
export class EventBus {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
    private readonly logger: AppLogger,
  ) {}

  async publish<T extends Record<string, unknown>>(
    type: DomainEventType | string,
    subject: { type: string; id: string },
    data: T,
    options: PublishOptions = {},
  ): Promise<string> {
    const context = RequestContextStore.get();
    const organizationId = options.organizationId ?? context?.organizationId;
    if (!organizationId) {
      throw new Error(`Cannot publish ${type}: no organization in scope`);
    }

    const id = newId('outbox');
    const record = {
      id,
      organizationId,
      workspaceId: options.workspaceId ?? context?.workspaceId ?? null,
      type,
      version: 1,
      actorType: (context?.principal?.type === 'api_key' ? 'user' : (context?.principal?.type ?? 'system')) as any,
      actorId: context?.principal?.id ?? null,
      subjectType: subject.type,
      subjectId: subject.id,
      data: data as Prisma.InputJsonValue,
      correlationId: context?.requestId ?? null,
      causationId: options.causationId ?? null,
    };

    const client = options.tx ?? this.prisma.raw;
    await client.outboxEvent.create({ data: record });

    // Fire in-process immediately; the relay will deliver the durable copy.
    this.emitLocal({
      id,
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      organizationId,
      workspaceId: record.workspaceId ?? undefined,
      actor: { type: record.actorType, id: record.actorId ?? undefined },
      subject,
      correlationId: record.correlationId ?? undefined,
      causationId: record.causationId ?? undefined,
      data,
    });

    return id;
  }

  /** Deliver to in-process listeners without touching the outbox. */
  emitLocal(envelope: DomainEventEnvelope): void {
    try {
      this.emitter.emit(envelope.type, envelope);
      this.emitter.emit('**', envelope);
    } catch (error) {
      this.logger.error('In-process event listener failed', error, { type: envelope.type });
    }
  }
}
