import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent, type DomainEventEnvelope } from '../../core/events/domain-events';
import { AppLogger } from '../../core/logger/logger.service';
import { QUEUES, QueueService } from '../../core/queue/queue.service';

/**
 * Schedules quality work rather than doing it inline: evaluation and live
 * monitoring both cost a model call, and neither should delay a customer's
 * message or an agent's resolve action.
 */
@Injectable()
export class QualityListener {
  constructor(
    private readonly queue: QueueService,
    private readonly logger: AppLogger,
  ) {}

  @OnEvent(DomainEvent.ConversationResolved)
  async onResolved(event: DomainEventEnvelope<{ conversationId: string }>) {
    try {
      await this.queue.enqueue(QUEUES.quality, 'evaluate-conversation', { conversationId: event.data.conversationId });
      await this.queue.enqueue(QUEUES.intelligence, 'extract-intelligence', { conversationId: event.data.conversationId });
    } catch (error) {
      this.logger.error('Could not schedule post-resolution analysis', error, { conversationId: event.data.conversationId });
    }
  }

  /**
   * Watch live conversations for compliance and frustration. Only inbound
   * customer messages trigger a check — an agent's own reply is not new
   * evidence about how the customer is feeling.
   */
  @OnEvent(DomainEvent.MessageCreated)
  async onMessage(event: DomainEventEnvelope<{ conversationId: string; messageId: string; direction: string }>) {
    if (event.data.direction !== 'inbound') return;
    try {
      await this.queue.enqueue(QUEUES.quality, 'monitor-live', {
        conversationId: event.data.conversationId,
        messageId: event.data.messageId,
      });
    } catch (error) {
      this.logger.debug('Could not schedule live monitoring', { reason: String(error) });
    }
  }
}
