import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { DomainEventEnvelope } from '../../core/events/domain-events';
import { AppLogger } from '../../core/logger/logger.service';
import { WebhooksService } from './webhooks.service';

/**
 * Fans every domain event out to the endpoints subscribed to it.
 *
 * One listener on `**` rather than a listener per event type: the point of the
 * developer platform is that a customer can subscribe to anything the platform
 * publishes, so a list here would be a second catalogue to forget to update.
 */
@Injectable()
export class WebhooksDispatcher {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly logger: AppLogger,
  ) {}

  @OnEvent('**')
  async onAny(envelope: DomainEventEnvelope): Promise<void> {
    // Wildcard listeners see everything, including whatever a future caller
    // emits, so the shape is checked rather than assumed.
    if (!envelope?.organizationId || typeof envelope.type !== 'string') return;

    // Webhook events are never themselves delivered by webhook. A failed
    // delivery publishes `webhook.delivery.failed`; delivering that to the same
    // unreachable endpoint fails, publishes another, and the outbox fills with
    // an event about an event about an event.
    if (envelope.type.startsWith('webhook.')) return;

    try {
      await this.webhooks.dispatch(envelope);
    } catch (error) {
      // The event itself has already happened and must not be rolled back
      // because a customer's subscription could not be queued.
      this.logger.error('Webhook fan-out failed', error, {
        eventId: envelope.id,
        type: envelope.type,
      });
    }
  }
}
