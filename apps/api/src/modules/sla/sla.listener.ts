import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent, type DomainEventEnvelope } from '../../core/events/domain-events';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SlaService } from './sla.service';

/**
 * Keeps SLA clocks in step with what actually happens to a conversation or
 * ticket, so no caller has to remember to start, pause or stop a clock.
 */
@Injectable()
export class SlaListener {
  constructor(
    private readonly sla: SlaService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly logger: AppLogger,
  ) {}

  @OnEvent(DomainEvent.ConversationCreated)
  async onConversationCreated(
    event: DomainEventEnvelope<{ conversationId: string; channel: string }>,
  ) {
    const conversation = await this.prisma.raw.conversation.findUnique({
      where: { id: event.data.conversationId },
      include: { customer: { select: { tier: true } } },
    });
    if (!conversation) return;

    await this.sla.startClocks({
      type: 'conversation',
      id: conversation.id,
      priority: conversation.priority,
      channel: conversation.channel,
      teamId: conversation.teamId,
      queueId: conversation.queueId,
      customerTier: conversation.customer?.tier,
    });
  }

  /** The first agent or AI reply stops the first-response clock. */
  @OnEvent(DomainEvent.MessageCreated)
  async onMessage(
    event: DomainEventEnvelope<{ conversationId: string; direction: string; authorType: string }>,
  ) {
    const { conversationId, direction, authorType } = event.data;

    if (direction === 'outbound' && (authorType === 'user' || authorType === 'ai_agent')) {
      await this.sla.completeClock('conversation', conversationId, 'first_response');
    }
    // A customer reply restarts the team's clock.
    if (direction === 'inbound') {
      await this.sla.resumeClocks('conversation', conversationId);
    }
  }

  @OnEvent(DomainEvent.ConversationStatusChanged)
  async onStatusChanged(event: DomainEventEnvelope<{ conversationId: string; to: string }>) {
    const { conversationId, to } = event.data;
    if (to === 'waiting') {
      // Time waiting on the customer is not the team's to answer for.
      await this.sla.pauseClocks('conversation', conversationId);
    } else if (to === 'active' || to === 'assigned') {
      await this.sla.resumeClocks('conversation', conversationId);
    }
  }

  @OnEvent(DomainEvent.ConversationResolved)
  async onResolved(event: DomainEventEnvelope<{ conversationId: string }>) {
    await this.sla.completeClock('conversation', event.data.conversationId, 'resolution');
    await this.sla.completeClock('conversation', event.data.conversationId, 'first_response');
  }

  @OnEvent(DomainEvent.ConversationClosed)
  async onClosed(event: DomainEventEnvelope<{ conversationId: string }>) {
    await this.sla.cancelClocks('conversation', event.data.conversationId);
  }

  @OnEvent(DomainEvent.TicketCreated)
  async onTicketCreated(event: DomainEventEnvelope<{ ticketId: string; priority: string }>) {
    const ticket = await this.prisma.raw.ticket.findUnique({
      where: { id: event.data.ticketId },
      include: { customer: { select: { tier: true } } },
    });
    if (!ticket) return;

    await this.sla.startClocks({
      type: 'ticket',
      id: ticket.id,
      priority: ticket.priority,
      channel: ticket.source,
      teamId: ticket.teamId,
      queueId: ticket.queueId,
      customerTier: ticket.customer?.tier,
    });
  }

  @OnEvent(DomainEvent.TicketResolved)
  async onTicketResolved(event: DomainEventEnvelope<{ ticketId: string }>) {
    await this.sla.completeClock('ticket', event.data.ticketId, 'resolution');
    await this.sla.completeClock('ticket', event.data.ticketId, 'first_response');
  }

  @OnEvent(DomainEvent.TicketReopened)
  async onTicketReopened(event: DomainEventEnvelope<{ ticketId: string }>) {
    const ticket = await this.prisma.raw.ticket.findUnique({ where: { id: event.data.ticketId } });
    if (!ticket) return;
    // A reopened ticket earns a fresh resolution target, not the expired one.
    await this.sla.cancelClocks('ticket', ticket.id);
    await this.sla.startClocks(
      {
        type: 'ticket',
        id: ticket.id,
        priority: ticket.priority,
        channel: ticket.source,
        teamId: ticket.teamId,
        queueId: ticket.queueId,
      },
      ['resolution'],
    );
  }

  /** Surface warnings and breaches in the workspace as they happen. */
  @OnEvent(DomainEvent.SlaWarning)
  onWarning(
    event: DomainEventEnvelope<{ targetType: string; subjectId: string; remainingMs: number }>,
  ) {
    this.realtime.emitToOrganization(event.organizationId, 'sla:warning', event.data);
  }

  @OnEvent(DomainEvent.SlaBreached)
  onBreach(event: DomainEventEnvelope<{ targetType: string; subjectId: string }>) {
    this.realtime.emitToOrganization(event.organizationId, 'sla:breached', event.data);
    this.logger.warn('SLA breached', { ...event.data, organizationId: event.organizationId });
  }
}
