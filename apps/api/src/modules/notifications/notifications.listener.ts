import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent, type DomainEventEnvelope } from '../../core/events/domain-events';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { NotificationsService } from './notifications.service';

/**
 * Turns platform events into notifications.
 *
 * Each handler enriches the event with the context a recipient needs — a
 * reference they can quote, the assignee, the subject's own identifiers — so a
 * rule can address the right person and the message says something useful.
 */
@Injectable()
export class NotificationsListener {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  private async dispatch(event: string, context: Record<string, unknown>) {
    try {
      await this.notifications.dispatch(event, context);
    } catch (error) {
      // Notification failure must never break the operation that caused it.
      this.logger.error('Notification dispatch failed', error, { event });
    }
  }

  @OnEvent(DomainEvent.SlaWarning)
  async onSlaWarning(
    event: DomainEventEnvelope<{ targetType: string; subjectId: string; remainingMs: number }>,
  ) {
    await this.dispatch('sla.warning', {
      ...event.data,
      ...(await this.subjectContext(event.data.subjectId)),
    });
  }

  @OnEvent(DomainEvent.SlaBreached)
  async onSlaBreached(event: DomainEventEnvelope<{ targetType: string; subjectId: string }>) {
    await this.dispatch('sla.breached', {
      ...event.data,
      ...(await this.subjectContext(event.data.subjectId)),
    });
  }

  @OnEvent(DomainEvent.TicketAssigned)
  async onTicketAssigned(event: DomainEventEnvelope<{ ticketId: string; assigneeId: string }>) {
    const ticket = await this.prisma.raw.ticket.findUnique({
      where: { id: event.data.ticketId },
      select: { reference: true, subject: true, priority: true, assigneeId: true },
    });
    await this.dispatch('ticket.assigned', { ...event.data, ...ticket });
  }

  @OnEvent(DomainEvent.TicketCreated)
  async onTicketCreated(event: DomainEventEnvelope<{ ticketId: string; priority: string }>) {
    const ticket = await this.prisma.raw.ticket.findUnique({
      where: { id: event.data.ticketId },
      select: { reference: true, subject: true, priority: true, assigneeId: true, teamId: true },
    });
    await this.dispatch('ticket.created', { ...event.data, ...ticket });
  }

  @OnEvent(DomainEvent.ConversationAssigned)
  async onConversationAssigned(
    event: DomainEventEnvelope<{
      conversationId: string;
      assigneeId: string;
      assigneeType: string;
    }>,
  ) {
    // An AI assignment is routing, not something to page a person about.
    if (event.data.assigneeType !== 'user') return;
    const conversation = await this.prisma.raw.conversation.findUnique({
      where: { id: event.data.conversationId },
      select: { reference: true, subject: true, priority: true, assigneeId: true },
    });
    await this.dispatch('conversation.assigned', { ...event.data, ...conversation });
  }

  @OnEvent(DomainEvent.ConversationTransferred)
  async onTransferred(
    event: DomainEventEnvelope<{ conversationId: string; to: string; reason: string }>,
  ) {
    const conversation = await this.prisma.raw.conversation.findUnique({
      where: { id: event.data.conversationId },
      select: { reference: true, subject: true, assigneeId: true },
    });
    await this.dispatch('conversation.transferred', { ...event.data, ...conversation });
  }

  @OnEvent(DomainEvent.HandoffRequested)
  async onHandoff(
    event: DomainEventEnvelope<{ conversationId: string; reason: string; confidence: number }>,
  ) {
    const conversation = await this.prisma.raw.conversation.findUnique({
      where: { id: event.data.conversationId },
      select: { reference: true, subject: true, queueId: true, assigneeId: true },
    });
    await this.dispatch('handoff.requested', { ...event.data, ...conversation });
  }

  /** Only a failing evaluation is worth an interruption; a pass is routine. */
  @OnEvent(DomainEvent.QcEvaluated)
  async onQcEvaluated(
    event: DomainEventEnvelope<{ evaluationId: string; subjectId: string; score: number }>,
  ) {
    const evaluation = await this.prisma.raw.qcEvaluation.findUnique({
      where: { id: event.data.evaluationId },
      include: { template: { select: { name: true, passingScore: true } } },
    });
    if (!evaluation) return;

    await this.dispatch(evaluation.passed ? 'qc.evaluated' : 'qc.failed', {
      ...event.data,
      templateName: evaluation.template.name,
      passingScore: evaluation.template.passingScore,
      passed: evaluation.passed,
      assigneeId: evaluation.subjectId,
      conversationId: evaluation.conversationId,
    });
  }

  @OnEvent(DomainEvent.ExecutionFailed)
  async onExecutionFailed(
    event: DomainEventEnvelope<{ executionId: string; nodeId: string; error: string }>,
  ) {
    await this.dispatch('execution.failed', event.data);
  }

  @OnEvent(DomainEvent.GuardrailTriggered)
  async onGuardrail(
    event: DomainEventEnvelope<{ action: string; severity: string; policy: string }>,
  ) {
    // Routine masking is noise; only a block or a high-severity decision matters.
    if (event.data.action !== 'block' && event.data.severity !== 'high') return;
    await this.dispatch('guardrail.triggered', event.data);
  }

  /** Resolve a conversation or ticket id into something a message can quote. */
  private async subjectContext(subjectId: string): Promise<Record<string, unknown>> {
    if (subjectId?.startsWith('cnv_')) {
      const conversation = await this.prisma.raw.conversation.findUnique({
        where: { id: subjectId },
        select: { reference: true, subject: true, assigneeId: true, queueId: true, priority: true },
      });
      return { conversationId: subjectId, ...conversation };
    }
    if (subjectId?.startsWith('tkt_')) {
      const ticket = await this.prisma.raw.ticket.findUnique({
        where: { id: subjectId },
        select: { reference: true, subject: true, assigneeId: true, teamId: true, priority: true },
      });
      return { ticketId: subjectId, ...ticket };
    }
    return {};
  }
}
