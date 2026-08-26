import { Injectable } from '@nestjs/common';
import { Prisma, type AutomationTrigger } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ChannelsService } from '../channels/channels.service';
import { ConversationsService } from '../conversations/conversations.service';
import { CustomersService } from '../customers/customers.service';
import { isEgressAllowed } from '../guardrails/detectors';
import { TicketsService } from '../tickets/tickets.service';
import { evaluateCondition, interpolate } from '../workflows/expressions';

export interface AutomationAction {
  type:
    | 'assign'
    | 'send_message'
    | 'send_email'
    | 'create_ticket'
    | 'update_ticket'
    | 'update_customer'
    | 'set_priority'
    | 'add_tag'
    | 'escalate'
    | 'webhook';
  config: Record<string, unknown>;
}

/**
 * Rule-based automation, independent of AI.
 *
 * Where the AI agent decides what to say, automation decides what the platform
 * should do — assign, escalate, tag, notify — deterministically and auditably.
 * Actions run in order and each is recorded, so a rule's effect can always be
 * traced back from the record it changed.
 */
@Injectable()
export class AutomationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly channels: ChannelsService,
    private readonly tickets: TicketsService,
    private readonly customers: CustomersService,
    private readonly events: EventBus,
    private readonly logger: AppLogger,
  ) {}

  // ── Rules ──────────────────────────────────────────────────────────────────

  async list() {
    return this.prisma.db.automationRule.findMany({ where: {}, orderBy: [{ trigger: 'asc' }, { position: 'asc' }] });
  }

  async create(input: {
    name: string;
    description?: string;
    trigger: AutomationTrigger;
    schedule?: string;
    conditions?: Record<string, unknown>;
    actions: AutomationAction[];
    position?: number;
    workspaceId?: string;
  }) {
    const principal = RequestContextStore.principal();
    return this.prisma.db.automationRule.create({
      data: {
        id: newId('automation'),
        name: input.name,
        description: input.description ?? null,
        trigger: input.trigger,
        schedule: input.schedule ?? null,
        conditions: (input.conditions ?? {}) as Prisma.InputJsonValue,
        actions: input.actions as unknown as Prisma.InputJsonValue,
        position: input.position ?? 0,
        workspaceId: input.workspaceId ?? null,
        createdById: principal?.id ?? null,
      } as never,
    });
  }

  async update(ruleId: string, patch: Record<string, unknown>) {
    return this.prisma.db.automationRule.update({ where: { id: ruleId }, data: patch as never });
  }

  async delete(ruleId: string) {
    await this.prisma.db.automationRule.delete({ where: { id: ruleId } });
  }

  async runs(ruleId?: string, limit = 50) {
    return this.prisma.db.automationRun.findMany({
      where: ruleId ? { ruleId } : {},
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  /**
   * Evaluate every active rule for a trigger against one subject. Rules run in
   * position order; a rule failing does not stop the rules after it, because
   * one bad webhook should not silently disable a tenant's whole automation.
   */
  async evaluate(trigger: AutomationTrigger, subject: { type: string; id: string }): Promise<number> {
    const rules = await this.prisma.db.automationRule.findMany({
      where: { trigger, isActive: true },
      orderBy: { position: 'asc' },
    });
    if (!rules.length) return 0;

    const scope = await this.buildScope(subject);
    if (!scope) return 0;

    let fired = 0;
    for (const rule of rules) {
      const started = Date.now();
      const conditions = (rule.conditions ?? {}) as { all?: Condition[]; any?: Condition[]; expression?: string };

      let matched: boolean;
      try {
        matched = this.matches(conditions, scope);
      } catch (error) {
        this.logger.warn('Automation condition failed to evaluate', { ruleId: rule.id, reason: String(error) });
        continue;
      }
      if (!matched) continue;

      const actionsRun: { type: string; ok: boolean; error?: string }[] = [];
      for (const action of (rule.actions ?? []) as unknown as AutomationAction[]) {
        try {
          await this.runAction(action, subject, scope);
          actionsRun.push({ type: action.type, ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          actionsRun.push({ type: action.type, ok: false, error: message });
          this.logger.error('Automation action failed', error, { ruleId: rule.id, action: action.type });
        }
      }

      await this.prisma.db.automationRun.create({
        data: {
          id: newId('automationRun'),
          ruleId: rule.id,
          subjectType: subject.type,
          subjectId: subject.id,
          matched: true,
          actionsRun: actionsRun as unknown as Prisma.InputJsonValue,
          durationMs: Date.now() - started,
        } as never,
      });
      await this.prisma.db.automationRule.update({
        where: { id: rule.id },
        data: { runCount: { increment: 1 }, lastRunAt: new Date() },
      });

      await this.events.publish(DomainEvent.AutomationFired, { type: 'automation', id: rule.id }, {
        ruleId: rule.id,
        subjectType: subject.type,
        subjectId: subject.id,
        actions: actionsRun.map((entry) => entry.type),
      });
      fired += 1;
    }

    return fired;
  }

  /** The facts a rule can test, assembled once per evaluation. */
  private async buildScope(subject: { type: string; id: string }): Promise<Record<string, unknown> | null> {
    if (subject.type === 'conversation') {
      const conversation = await this.prisma.db.conversation.findFirst({
        where: { id: subject.id },
        include: {
          customer: { select: { id: true, tier: true, tags: true, company: true, displayName: true } },
          intelligence: true,
        },
      });
      if (!conversation) return null;
      return {
        conversation: {
          id: conversation.id,
          channel: conversation.channel,
          status: conversation.status,
          priority: conversation.priority,
          locale: conversation.locale,
          tags: conversation.tags,
          messageCount: conversation.messageCount,
          aiHandled: conversation.aiHandled,
          queueId: conversation.queueId,
        },
        customer: conversation.customer ?? {},
        ai: {
          intent: conversation.intelligence?.intent,
          sentiment: conversation.intelligence?.sentiment,
          sentimentScore: conversation.intelligence?.sentimentScore,
          churnRisk: conversation.intelligence?.churnRisk,
        },
      };
    }

    if (subject.type === 'ticket') {
      const ticket = await this.prisma.db.ticket.findFirst({
        where: { id: subject.id },
        include: { customer: { select: { id: true, tier: true, tags: true, company: true } } },
      });
      if (!ticket) return null;
      return {
        ticket: {
          id: ticket.id,
          status: ticket.status,
          priority: ticket.priority,
          category: ticket.category,
          labels: ticket.labels,
          source: ticket.source,
          reopenCount: ticket.reopenCount,
        },
        customer: ticket.customer ?? {},
      };
    }

    if (subject.type === 'customer') {
      const customer = await this.prisma.db.customer.findFirst({ where: { id: subject.id } });
      return customer ? { customer } : null;
    }

    return { subject };
  }

  /**
   * `all` conditions must every one hold, `any` needs one, and an optional
   * expression is ANDed on top. An empty condition set matches everything here —
   * unlike routing, an automation rule with no conditions is a legitimate
   * "always do this on trigger X".
   */
  private matches(
    conditions: { all?: Condition[]; any?: Condition[]; expression?: string },
    scope: Record<string, unknown>,
  ): boolean {
    const all = conditions.all ?? [];
    const any = conditions.any ?? [];

    if (all.length && !all.every((condition) => this.test(condition, scope))) return false;
    if (any.length && !any.some((condition) => this.test(condition, scope))) return false;
    if (conditions.expression && !evaluateCondition(conditions.expression, scope)) return false;
    return true;
  }

  private test(condition: Condition, scope: Record<string, unknown>): boolean {
    const value = condition.field.split('.').reduce<unknown>((current, key) => {
      if (current === null || current === undefined) return undefined;
      return (current as Record<string, unknown>)[key];
    }, scope);

    const expected = condition.value;
    switch (condition.op) {
      case 'eq':
        return String(value ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
      case 'neq':
        return String(value ?? '').toLowerCase() !== String(expected ?? '').toLowerCase();
      case 'in':
        return Array.isArray(expected) && expected.some((entry) => String(entry).toLowerCase() === String(value ?? '').toLowerCase());
      case 'contains':
        if (Array.isArray(value)) return value.some((entry) => String(entry).toLowerCase() === String(expected ?? '').toLowerCase());
        return String(value ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
      case 'gt':
        return Number(value) > Number(expected);
      case 'lt':
        return Number(value) < Number(expected);
      case 'exists':
        return value !== undefined && value !== null && value !== '';
      case 'not_exists':
        return value === undefined || value === null || value === '';
      default:
        return false;
    }
  }

  private async runAction(action: AutomationAction, subject: { type: string; id: string }, scope: Record<string, unknown>): Promise<void> {
    const config = action.config ?? {};
    const text = (key: string, fallback = ''): string => {
      const raw = config[key];
      return typeof raw === 'string' ? interpolate(raw, scope) : fallback;
    };

    switch (action.type) {
      case 'assign': {
        if (subject.type !== 'conversation') return;
        const userId = text('userId');
        await this.conversations.assign(
          subject.id,
          userId ? { type: 'user', id: userId } : null,
          { reason: 'automation', queueId: (config.queueId as string) ?? undefined },
        );
        return;
      }

      case 'send_message':
      case 'send_email': {
        if (subject.type !== 'conversation') return;
        const body = text('body');
        if (!body) return;
        await this.channels.sendReply({ conversationId: subject.id, body, authorType: 'ai_agent' });
        return;
      }

      case 'create_ticket': {
        const payload = {
          subject: text('subject', 'Automated follow-up'),
          description: text('description') || undefined,
          priority: config.priority as string | undefined,
          category: config.category as string | undefined,
        };
        if (subject.type === 'conversation') await this.tickets.createFromConversation(subject.id, payload as never);
        else await this.tickets.create(payload as never);
        return;
      }

      case 'update_ticket': {
        if (subject.type !== 'ticket') return;
        await this.tickets.update(subject.id, {
          status: config.status as string | undefined,
          priority: config.priority as string | undefined,
          category: config.category as string | undefined,
        } as never);
        return;
      }

      case 'set_priority': {
        const priority = config.priority as string;
        if (!priority) return;
        if (subject.type === 'conversation') await this.conversations.update(subject.id, { priority });
        else if (subject.type === 'ticket') await this.tickets.update(subject.id, { priority } as never);
        return;
      }

      case 'escalate': {
        if (subject.type !== 'conversation') return;
        await this.conversations.update(subject.id, { priority: (config.priority as string) ?? 'urgent' });
        await this.conversations.transfer(
          subject.id,
          { teamId: config.teamId as string | undefined, queueId: config.queueId as string | undefined, userId: config.userId as string | undefined },
          text('reason', 'Escalated by automation'),
        );
        return;
      }

      case 'add_tag': {
        const tag = text('tag');
        if (!tag) return;
        if (subject.type === 'conversation') {
          const conversation = await this.conversations.get(subject.id);
          await this.conversations.update(subject.id, { tags: [...new Set([...conversation.tags, tag])] });
        } else if (subject.type === 'customer') {
          const customer = await this.customers.get(subject.id);
          await this.customers.update(subject.id, { tags: [...new Set([...customer.tags, tag])] });
        }
        return;
      }

      case 'update_customer': {
        const customerId = (scope.customer as { id?: string })?.id ?? (subject.type === 'customer' ? subject.id : undefined);
        if (!customerId) return;
        const fields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries((config.fields ?? {}) as Record<string, unknown>)) {
          fields[key] = typeof value === 'string' ? interpolate(value, scope) : value;
        }
        await this.customers.update(customerId, fields as never);
        return;
      }

      case 'webhook': {
        const url = text('url');
        // The same egress control as a tool: automation must not be a way to
        // reach the internal network.
        const egress = isEgressAllowed(url);
        if (!egress.allowed) throw new Error(`The webhook target was refused: ${egress.reason}`);

        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...((config.headers ?? {}) as Record<string, string>) },
          body: JSON.stringify({ subject, scope, firedAt: new Date().toISOString() }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        return;
      }

      default:
        this.logger.warn('Unknown automation action', { type: action.type });
    }
  }

  /** Preview which rules would fire, without running their actions. */
  async simulate(trigger: AutomationTrigger, subject: { type: string; id: string }) {
    const rules = await this.prisma.db.automationRule.findMany({ where: { trigger, isActive: true }, orderBy: { position: 'asc' } });
    const scope = await this.buildScope(subject);
    if (!scope) return { scope: null, matches: [] };

    return {
      scope,
      matches: rules.map((rule) => {
        let matched = false;
        let error: string | undefined;
        try {
          matched = this.matches((rule.conditions ?? {}) as never, scope);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        return { ruleId: rule.id, name: rule.name, matched, error, actions: (rule.actions as unknown as AutomationAction[]).map((a) => a.type) };
      }),
    };
  }
}

interface Condition {
  field: string;
  op: 'eq' | 'neq' | 'in' | 'contains' | 'gt' | 'lt' | 'exists' | 'not_exists';
  value?: unknown;
}
