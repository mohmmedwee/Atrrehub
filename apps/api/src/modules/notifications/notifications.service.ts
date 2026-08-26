import { Injectable } from '@nestjs/common';
import { Prisma, type NotificationChannel } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { MailService } from '../../core/mail/mail.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { isEgressAllowed } from '../guardrails/detectors';
import { evaluateCondition, interpolate } from '../workflows/expressions';
import { cursorArgs, paginate, type CursorParams } from '../../common/pagination';

export interface NotificationAudience {
  /** Everyone holding one of these role keys. */
  roles?: string[];
  userIds?: string[];
  teamIds?: string[];
  /** The person the subject is assigned to — usually who actually needs to know. */
  assignee?: boolean;
  /** A fixed address, for an on-call alias or a webhook target. */
  addresses?: string[];
  webhookUrl?: string;
}

export interface NotifyInput {
  event: string;
  title: string;
  body?: string;
  link?: string;
  data?: Record<string, unknown>;
  /** Overrides rule-based resolution when the recipient is already known. */
  userIds?: string[];
}

/** Events a rule can subscribe to, and how each is described by default. */
export const NOTIFIABLE_EVENTS: Record<string, { label: string; defaultTitle: string }> = {
  'ticket.assigned': { label: 'Ticket assigned', defaultTitle: 'A ticket was assigned to you' },
  'ticket.created': { label: 'Ticket created', defaultTitle: 'A new ticket was created' },
  'ticket.resolved': { label: 'Ticket resolved', defaultTitle: 'A ticket was resolved' },
  'conversation.assigned': {
    label: 'Conversation assigned',
    defaultTitle: 'A conversation was assigned to you',
  },
  'conversation.transferred': {
    label: 'Conversation transferred',
    defaultTitle: 'A conversation was transferred to you',
  },
  'sla.warning': { label: 'SLA warning', defaultTitle: 'An SLA target is close to breaching' },
  'sla.breached': { label: 'SLA breached', defaultTitle: 'An SLA target has been breached' },
  'handoff.requested': {
    label: 'AI handoff',
    defaultTitle: 'An AI agent handed a conversation to a person',
  },
  'qc.evaluated': { label: 'Quality evaluation', defaultTitle: 'A quality evaluation completed' },
  'qc.failed': { label: 'Quality failure', defaultTitle: 'A quality evaluation did not pass' },
  'guardrail.triggered': {
    label: 'Guardrail triggered',
    defaultTitle: 'A guardrail blocked or diverted an AI response',
  },
  'execution.failed': { label: 'Workflow failure', defaultTitle: 'A workflow execution failed' },
  'evaluation.failed': {
    label: 'Evaluation gate failed',
    defaultTitle: 'An agent failed its evaluation gate',
  },
  'usage.limit': { label: 'Usage limit', defaultTitle: 'An AI usage limit was reached' },
};

/**
 * Notification delivery.
 *
 * Rules map a platform event to an audience and a set of channels. Resolution
 * is deliberately conservative: a rule that resolves to nobody sends nothing
 * rather than falling back to everyone, because the failure mode of a
 * misconfigured alert rule is a tenant-wide page at 3am.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly realtime: RealtimeGateway,
    private readonly events: EventBus,
    private readonly logger: AppLogger,
  ) {}

  // ── Rules ──────────────────────────────────────────────────────────────────

  async listRules() {
    return this.prisma.db.notificationRule.findMany({
      where: {},
      orderBy: [{ event: 'asc' }, { name: 'asc' }],
    });
  }

  async createRule(input: {
    name: string;
    event: string;
    channels: NotificationChannel[];
    audience: NotificationAudience;
    template?: string;
    conditions?: Record<string, unknown>;
  }) {
    if (!NOTIFIABLE_EVENTS[input.event]) {
      throw AppError.badRequest(
        `"${input.event}" is not a notifiable event. Known events: ${Object.keys(NOTIFIABLE_EVENTS).join(', ')}`,
      );
    }
    if (!input.channels.length)
      throw AppError.badRequest('A rule needs at least one delivery channel');

    // A webhook channel without a target would silently deliver nothing.
    if (input.channels.includes('webhook')) {
      if (!input.audience.webhookUrl)
        throw AppError.badRequest('A webhook channel needs audience.webhookUrl');
      const egress = isEgressAllowed(input.audience.webhookUrl);
      if (!egress.allowed)
        throw AppError.badRequest(`The webhook target was refused: ${egress.reason}`);
    }

    return this.prisma.db.notificationRule.create({
      data: {
        id: newId('notificationRule'),
        name: input.name,
        event: input.event,
        channels: input.channels,
        audience: input.audience as unknown as Prisma.InputJsonValue,
        template: input.template ?? null,
        conditions: (input.conditions ?? {}) as Prisma.InputJsonValue,
      } as never,
    });
  }

  async updateRule(ruleId: string, patch: Record<string, unknown>) {
    return this.prisma.db.notificationRule.update({ where: { id: ruleId }, data: patch as never });
  }

  async deleteRule(ruleId: string) {
    await this.prisma.db.notificationRule.delete({ where: { id: ruleId } });
  }

  catalog() {
    return Object.entries(NOTIFIABLE_EVENTS).map(([event, meta]) => ({ event, ...meta }));
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  /**
   * Fire every active rule for an event. Each rule resolves its own audience,
   * so one event can page on-call by webhook while also landing in the assigned
   * agent's inbox.
   */
  async dispatch(event: string, context: Record<string, unknown>): Promise<number> {
    const rules = await this.prisma.db.notificationRule.findMany({
      where: { event, isActive: true },
    });
    if (!rules.length) return 0;

    let delivered = 0;
    for (const rule of rules) {
      const conditions = (rule.conditions ?? {}) as { expression?: string };
      if (conditions.expression) {
        try {
          if (!evaluateCondition(conditions.expression, context)) continue;
        } catch (error) {
          this.logger.warn('Notification rule condition failed to evaluate', {
            ruleId: rule.id,
            reason: String(error),
          });
          continue;
        }
      }

      const meta = NOTIFIABLE_EVENTS[event];
      const title = rule.template
        ? interpolate(rule.template, context)
        : (meta?.defaultTitle ?? event);
      const audience = (rule.audience ?? {}) as NotificationAudience;

      const recipients = await this.resolveAudience(audience, context);
      if (!recipients.length && !audience.webhookUrl && !audience.addresses?.length) {
        // Say so rather than failing silently — an alert nobody receives is worse
        // than no alert, because it looks configured.
        this.logger.warn('Notification rule resolved to nobody', { ruleId: rule.id, event });
        continue;
      }

      delivered += await this.deliver({
        event,
        title,
        body: this.describe(event, context),
        link: this.linkFor(context),
        data: context,
        channels: rule.channels,
        recipients,
        audience,
      });
    }
    return delivered;
  }

  /** Deliver directly, bypassing rules — for a targeted, always-wanted message. */
  async notify(input: NotifyInput & { channels?: NotificationChannel[] }): Promise<number> {
    return this.deliver({
      event: input.event,
      title: input.title,
      body: input.body,
      link: input.link,
      data: input.data ?? {},
      channels: input.channels ?? ['in_app'],
      recipients: input.userIds ?? [],
      audience: {},
    });
  }

  private async deliver(params: {
    event: string;
    title: string;
    body?: string;
    link?: string;
    data: Record<string, unknown>;
    channels: NotificationChannel[];
    recipients: string[];
    audience: NotificationAudience;
  }): Promise<number> {
    const organizationId = RequestContextStore.organizationId()!;
    let count = 0;

    for (const channel of params.channels) {
      if (channel === 'webhook') {
        if (await this.sendWebhook(params.audience.webhookUrl, params)) count += 1;
        continue;
      }

      if (channel === 'email' && params.audience.addresses?.length) {
        for (const address of params.audience.addresses) {
          if (await this.sendEmail(address, params)) count += 1;
        }
      }

      for (const userId of params.recipients) {
        const record = await this.prisma.raw.notification.create({
          data: {
            id: newId('notification'),
            organizationId,
            userId,
            channel,
            event: params.event,
            title: params.title,
            body: params.body ?? null,
            link: params.link ?? null,
            data: params.data as Prisma.InputJsonValue,
          },
        });

        let sent = false;
        if (channel === 'in_app') {
          // Push immediately; the row is the durable copy for the inbox.
          this.realtime.emitToUser(organizationId, userId, 'notification', {
            id: record.id,
            event: params.event,
            title: params.title,
            body: params.body,
            link: params.link,
          });
          sent = true;
        } else if (channel === 'email') {
          const user = await this.prisma.raw.user.findUnique({
            where: { id: userId },
            select: { email: true, firstName: true },
          });
          sent = user ? await this.sendEmail(user.email, params, user.firstName) : false;
        } else {
          // SMS and push need a provider this deployment does not configure.
          await this.prisma.raw.notification.update({
            where: { id: record.id },
            data: { failedReason: `No ${channel} provider is configured` },
          });
          continue;
        }

        if (sent) {
          await this.prisma.raw.notification.update({
            where: { id: record.id },
            data: { sentAt: new Date() },
          });
          count += 1;
        }
      }
    }

    if (count) {
      await this.events
        .publish(
          DomainEvent.NotificationSent,
          { type: 'notification', id: params.event },
          {
            channel: params.channels.join(','),
            recipientId: params.recipients[0],
            ruleId: params.event,
          },
        )
        .catch(() => undefined);
    }
    return count;
  }

  /**
   * Turn an audience specification into user ids. Roles, teams and explicit
   * users union together; `assignee` picks the person the subject is assigned
   * to, which is the common case for a ticket or conversation alert.
   */
  private async resolveAudience(
    audience: NotificationAudience,
    context: Record<string, unknown>,
  ): Promise<string[]> {
    const recipients = new Set<string>(audience.userIds ?? []);

    if (audience.roles?.length) {
      const memberships = await this.prisma.db.membership.findMany({
        where: { role: { key: { in: audience.roles } } },
        select: { userId: true },
      });
      for (const membership of memberships) recipients.add(membership.userId);
    }

    if (audience.teamIds?.length) {
      const members = await this.prisma.raw.teamMember.findMany({
        where: { teamId: { in: audience.teamIds } },
        select: { userId: true },
      });
      for (const member of members) recipients.add(member.userId);
    }

    if (audience.assignee) {
      const assigneeId = this.findAssignee(context);
      if (assigneeId) recipients.add(assigneeId);
    }

    return [...recipients];
  }

  /** The assignee is nested differently per subject, so look in the usual places. */
  private findAssignee(context: Record<string, unknown>): string | null {
    const candidates = [
      context.assigneeId,
      (context.ticket as { assigneeId?: string } | undefined)?.assigneeId,
      (context.conversation as { assigneeId?: string } | undefined)?.assigneeId,
    ];
    return (
      (candidates.find(
        (value) => typeof value === 'string' && value.startsWith('usr_'),
      ) as string) ?? null
    );
  }

  private describe(event: string, context: Record<string, unknown>): string {
    const reference = (context.reference as string) ?? (context.subjectId as string) ?? '';
    switch (event) {
      case 'sla.warning':
        return `${reference} is approaching its ${String(context.targetType ?? 'SLA')} target.`;
      case 'sla.breached':
        return `${reference} has breached its ${String(context.targetType ?? 'SLA')} target.`;
      case 'handoff.requested':
        return `The AI agent handed over: ${String(context.reason ?? 'no reason given')}.`;
      case 'qc.failed':
        return `Scored ${String(context.score ?? '?')} against ${String(context.templateName ?? 'the scorecard')}.`;
      case 'execution.failed':
        return `${String(context.error ?? 'The workflow failed')}.`;
      default:
        return reference ? `Reference ${reference}.` : '';
    }
  }

  private linkFor(context: Record<string, unknown>): string | undefined {
    const conversationId = context.conversationId as string | undefined;
    const ticketId = context.ticketId as string | undefined;
    if (conversationId) return `/workspace?conversation=${conversationId}`;
    if (ticketId) return `/workspace?ticket=${ticketId}`;
    return undefined;
  }

  private async sendEmail(
    address: string,
    params: { title: string; body?: string; link?: string },
    firstName?: string,
  ): Promise<boolean> {
    try {
      await this.mail.send({
        to: address,
        subject: params.title,
        html: this.mail.renderLayout({
          title: params.title,
          body: `${firstName ? `<p>Hello ${escapeHtml(firstName)},</p>` : ''}<p>${escapeHtml(params.body ?? '')}</p>`,
          ...(params.link ? { ctaLabel: 'Open in Atrrehub', ctaUrl: params.link } : {}),
        }),
        text: `${params.title}\n\n${params.body ?? ''}`,
      });
      return true;
    } catch (error) {
      this.logger.error('Notification email failed', error, { address });
      return false;
    }
  }

  private async sendWebhook(
    url: string | undefined,
    params: { event: string; title: string; data: Record<string, unknown> },
  ): Promise<boolean> {
    if (!url) return false;
    const egress = isEgressAllowed(url);
    if (!egress.allowed) {
      this.logger.warn('Notification webhook refused', { reason: egress.reason });
      return false;
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: params.event,
          title: params.title,
          data: params.data,
          at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      return response.ok;
    } catch (error) {
      this.logger.warn('Notification webhook failed', { reason: String(error) });
      return false;
    }
  }

  // ── Inbox ──────────────────────────────────────────────────────────────────

  async inbox(userId: string, params: CursorParams & { unreadOnly?: boolean }) {
    const rows = await this.prisma.db.notification.findMany({
      where: { userId, channel: 'in_app', ...(params.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      ...cursorArgs(params),
    });
    return paginate(rows, params.limit);
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.db.notification.count({
      where: { userId, channel: 'in_app', readAt: null },
    });
  }

  async markRead(userId: string, notificationId: string) {
    // Scoped by user so one member cannot clear another's inbox.
    const updated = await this.prisma.db.notification.updateMany({
      where: { id: notificationId, userId },
      data: { readAt: new Date() },
    });
    if (!updated.count) throw AppError.notFound('Notification', notificationId);
    return { id: notificationId, readAt: new Date() };
  }

  async markAllRead(userId: string): Promise<number> {
    const updated = await this.prisma.db.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return updated.count;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
