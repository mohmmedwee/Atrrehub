import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent, type DomainEventEnvelope } from '../../core/events/domain-events';
import { AppLogger } from '../../core/logger/logger.service';
import { AutomationService } from './automation.service';

/** Feeds platform events into the automation engine. */
@Injectable()
export class AutomationListener {
  constructor(
    private readonly automation: AutomationService,
    private readonly logger: AppLogger,
  ) {}

  private async evaluate(
    trigger: Parameters<AutomationService['evaluate']>[0],
    subject: { type: string; id: string },
  ) {
    try {
      await this.automation.evaluate(trigger, subject);
    } catch (error) {
      // Automation must never break the operation that triggered it.
      this.logger.error('Automation evaluation failed', error, { trigger, subject });
    }
  }

  @OnEvent(DomainEvent.ConversationCreated)
  async onConversationCreated(event: DomainEventEnvelope<{ conversationId: string }>) {
    await this.evaluate('conversation_created', {
      type: 'conversation',
      id: event.data.conversationId,
    });
  }

  @OnEvent(DomainEvent.MessageCreated)
  async onMessage(event: DomainEventEnvelope<{ conversationId: string; direction: string }>) {
    if (event.data.direction !== 'inbound') return;
    await this.evaluate('message_received', {
      type: 'conversation',
      id: event.data.conversationId,
    });
  }

  @OnEvent(DomainEvent.ConversationResolved)
  async onResolved(event: DomainEventEnvelope<{ conversationId: string }>) {
    await this.evaluate('conversation_resolved', {
      type: 'conversation',
      id: event.data.conversationId,
    });
  }

  @OnEvent(DomainEvent.TicketCreated)
  async onTicketCreated(event: DomainEventEnvelope<{ ticketId: string }>) {
    await this.evaluate('ticket_created', { type: 'ticket', id: event.data.ticketId });
  }

  @OnEvent(DomainEvent.TicketUpdated)
  async onTicketUpdated(event: DomainEventEnvelope<{ ticketId: string }>) {
    await this.evaluate('ticket_updated', { type: 'ticket', id: event.data.ticketId });
  }

  @OnEvent(DomainEvent.CustomerCreated)
  async onCustomerCreated(event: DomainEventEnvelope<{ customerId: string }>) {
    await this.evaluate('customer_created', { type: 'customer', id: event.data.customerId });
  }

  @OnEvent(DomainEvent.SlaWarning)
  async onSlaWarning(event: DomainEventEnvelope<{ subjectId: string }>) {
    await this.evaluate('sla_warning', { type: 'conversation', id: event.data.subjectId });
  }

  @OnEvent(DomainEvent.SlaBreached)
  async onSlaBreach(event: DomainEventEnvelope<{ subjectId: string }>) {
    await this.evaluate('sla_breach', { type: 'conversation', id: event.data.subjectId });
  }

  @OnEvent(DomainEvent.IntelExtracted)
  async onSentimentChanged(event: DomainEventEnvelope<{ conversationId: string }>) {
    await this.evaluate('sentiment_changed', {
      type: 'conversation',
      id: event.data.conversationId,
    });
  }
}
