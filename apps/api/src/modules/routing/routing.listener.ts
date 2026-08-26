import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent, type DomainEventEnvelope } from '../../core/events/domain-events';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RoutingService } from './routing.service';

/**
 * Routes conversations automatically as they arrive, and drains queues when
 * capacity frees up, so work never sits waiting for a human to notice it.
 */
@Injectable()
export class RoutingListener {
  constructor(
    private readonly routing: RoutingService,
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  @OnEvent(DomainEvent.ConversationCreated)
  async onCreated(event: DomainEventEnvelope<{ conversationId: string }>) {
    try {
      await this.routing.route(event.data.conversationId);
    } catch (error) {
      // A routing failure must leave the conversation queued, not lost.
      this.logger.error('Automatic routing failed', error, {
        conversationId: event.data.conversationId,
      });
    }
  }

  /**
   * When a conversation is resolved or closed its agent gains capacity, so the
   * queue they were serving is worth draining immediately.
   */
  @OnEvent(DomainEvent.ConversationResolved)
  @OnEvent(DomainEvent.ConversationClosed)
  async onFreedCapacity(event: DomainEventEnvelope<{ conversationId: string }>) {
    const conversation = await this.prisma.raw.conversation.findUnique({
      where: { id: event.data.conversationId },
      select: { queueId: true },
    });
    if (!conversation?.queueId) return;
    try {
      const assigned = await this.routing.drainQueue(conversation.queueId, 5);
      if (assigned)
        this.logger.debug('Drained queue after capacity freed', {
          queueId: conversation.queueId,
          assigned,
        });
    } catch (error) {
      this.logger.error('Queue drain failed', error, { queueId: conversation.queueId });
    }
  }
}
