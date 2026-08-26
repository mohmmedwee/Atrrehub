import { Injectable } from '@nestjs/common';
import { Prisma, type GuardrailAction, type GuardrailStage } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { MetricsService } from '../../core/metrics/metrics.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { detectContentPolicy, detectPromptInjection, isEgressAllowed, maskPii } from './detectors';

export interface GuardrailRule {
  stage: GuardrailStage;
  check: string;
  action: GuardrailAction;
  severity?: string;
  config?: Record<string, unknown>;
}

export interface GuardrailContext {
  policyId?: string | null;
  conversationId?: string;
  executionId?: string;
  subjectType?: string;
  subjectId?: string;
  /** Hosts a tool may reach, from the tenant's governance policy. */
  egressAllowlist?: string[];
}

export interface GuardrailVerdict {
  action: GuardrailAction;
  /** The text to use downstream — possibly masked. */
  text: string;
  triggered: { check: string; action: GuardrailAction; severity: string; evidence: string[] }[];
  blocked: boolean;
  handoff: boolean;
  reason?: string;
}

const DEFAULT_RULES: GuardrailRule[] = [
  { stage: 'input', check: 'prompt_injection', action: 'handoff', severity: 'high' },
  { stage: 'input', check: 'max_length', action: 'block', severity: 'low', config: { maxChars: 8000 } },
  { stage: 'tool', check: 'egress_allowlist', action: 'block', severity: 'high' },
  { stage: 'output', check: 'pii', action: 'mask', severity: 'medium' },
  { stage: 'output', check: 'content_policy', action: 'block', severity: 'high' },
  { stage: 'decision', check: 'confidence', action: 'handoff', severity: 'medium' },
];

/**
 * The guardrail pipeline.
 *
 * Checks run in order for a stage and the first `block` wins; `mask` rewrites
 * the text and continues, so several masks compose. Every non-allow decision is
 * recorded, because "why did the agent refuse?" must be answerable after the
 * fact.
 */
@Injectable()
export class GuardrailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventBus,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  async policyFor(policyId?: string | null) {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return null;
    return this.redis.remember(
      this.redis.key(organizationId, 'guardrail', policyId ?? 'default'),
      300,
      async () =>
        policyId
          ? this.prisma.raw.guardrailPolicy.findFirst({ where: { id: policyId, organizationId } })
          : this.prisma.raw.guardrailPolicy.findFirst({ where: { organizationId, isDefault: true } }),
    );
  }

  private async rulesFor(stage: GuardrailStage, policyId?: string | null): Promise<{ rules: GuardrailRule[]; policy: Awaited<ReturnType<GuardrailsService['policyFor']>> }> {
    const policy = await this.policyFor(policyId);
    const configured = ((policy?.rules ?? []) as unknown as GuardrailRule[]).filter((rule) => rule.stage === stage);
    return { rules: configured.length ? configured : DEFAULT_RULES.filter((rule) => rule.stage === stage), policy };
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** Screen an inbound customer message before it reaches a model. */
  async checkInput(text: string, context: GuardrailContext = {}): Promise<GuardrailVerdict> {
    const { rules } = await this.rulesFor('input', context.policyId);
    const verdict: GuardrailVerdict = { action: 'allow', text, triggered: [], blocked: false, handoff: false };

    for (const rule of rules) {
      if (rule.check === 'prompt_injection') {
        const detection = detectPromptInjection(text);
        if (detection.matched) {
          this.apply(verdict, rule, detection.evidence, 'Possible prompt injection detected');
          if (verdict.blocked) break;
        }
      }

      if (rule.check === 'max_length') {
        const maxChars = Number(rule.config?.maxChars ?? 8000);
        if (text.length > maxChars) {
          this.apply(verdict, rule, [`length ${text.length} exceeds ${maxChars}`], 'The message is too long to process');
          if (verdict.blocked) break;
        }
      }

      if (rule.check === 'pii') {
        const { masked, matches } = maskPii(verdict.text);
        if (matches.length) {
          verdict.text = rule.action === 'mask' ? masked : verdict.text;
          this.apply(verdict, rule, matches.map((match) => match.kind), 'Sensitive data detected in the message');
        }
      }
    }

    await this.record(verdict, 'input', context);
    return verdict;
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  /** Screen a model's answer before it reaches the customer. */
  async checkOutput(
    text: string,
    context: GuardrailContext & { groundedness?: { score: number; unsupported: string[] }; confidence?: number } = {},
  ): Promise<GuardrailVerdict> {
    const { rules, policy } = await this.rulesFor('output', context.policyId);
    const verdict: GuardrailVerdict = { action: 'allow', text, triggered: [], blocked: false, handoff: false };

    for (const rule of rules) {
      if (rule.check === 'pii' && (policy?.maskPii ?? true)) {
        const { masked, matches } = maskPii(verdict.text);
        if (matches.length) {
          verdict.text = masked;
          this.apply(verdict, rule, matches.map((match) => match.kind), 'Sensitive data removed from the reply');
        }
      }

      if (rule.check === 'content_policy') {
        const detection = detectContentPolicy(verdict.text);
        if (detection.matched) {
          this.apply(verdict, rule, detection.evidence, 'The reply breached the content policy');
          if (verdict.blocked) break;
        }
      }

      if (rule.check === 'groundedness' && context.groundedness) {
        const mode = policy?.groundednessMode ?? 'flag';
        const threshold = Number(rule.config?.minScore ?? 0.5);
        if (context.groundedness.score < threshold) {
          this.apply(
            verdict,
            { ...rule, action: mode === 'block' ? 'block' : 'flag' },
            context.groundedness.unsupported.slice(0, 3),
            'The reply was not fully supported by the retrieved sources',
          );
          if (verdict.blocked) break;
        }
      }
    }

    // The confidence threshold is a decision-stage check, evaluated last.
    const threshold = policy?.confidenceThreshold ?? 0.7;
    if (context.confidence !== undefined && context.confidence < threshold) {
      this.apply(
        verdict,
        { stage: 'decision', check: 'confidence', action: 'handoff', severity: 'medium' },
        [`confidence ${context.confidence.toFixed(2)} below ${threshold}`],
        'The agent was not confident enough to answer',
      );
    }

    await this.record(verdict, 'output', context);
    return verdict;
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  /**
   * Authorize a tool invocation: the agent version must declare it, the tenant's
   * governance policy must allow it, and its endpoint must clear egress control.
   */
  async checkToolCall(
    tool: { key: string; url?: string | null; requiresApproval: boolean },
    context: GuardrailContext & { allowedTools?: string[]; declaredTools?: string[] } = {},
  ): Promise<GuardrailVerdict> {
    const verdict: GuardrailVerdict = { action: 'allow', text: tool.key, triggered: [], blocked: false, handoff: false };

    if (context.declaredTools && !context.declaredTools.includes(tool.key)) {
      this.apply(
        verdict,
        { stage: 'tool', check: 'authorization', action: 'block', severity: 'high' },
        [tool.key],
        `The agent is not permitted to use the ${tool.key} tool`,
      );
    }

    if (context.allowedTools?.length && !context.allowedTools.includes(tool.key)) {
      this.apply(
        verdict,
        { stage: 'tool', check: 'governance', action: 'block', severity: 'high' },
        [tool.key],
        `Organization policy does not allow the ${tool.key} tool`,
      );
    }

    if (tool.url) {
      const egress = isEgressAllowed(tool.url, context.egressAllowlist);
      if (!egress.allowed) {
        this.apply(
          verdict,
          { stage: 'tool', check: 'egress_allowlist', action: 'block', severity: 'high' },
          [egress.reason ?? 'blocked'],
          `The tool endpoint was refused: ${egress.reason}`,
        );
      }
    }

    if (tool.requiresApproval) {
      this.apply(
        verdict,
        { stage: 'tool', check: 'human_approval', action: 'handoff', severity: 'medium' },
        [tool.key],
        `The ${tool.key} tool requires human approval`,
      );
    }

    await this.record(verdict, 'tool', context);
    return verdict;
  }

  /** Retrieval scope, intersected with what the agent version declares. */
  async scopeRetrieval(declaredBaseIds: string[], readableBaseIds: string[]): Promise<string[]> {
    if (!declaredBaseIds.length) return [];
    return declaredBaseIds.filter((id) => readableBaseIds.includes(id));
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  private apply(verdict: GuardrailVerdict, rule: GuardrailRule, evidence: string[], reason: string): void {
    verdict.triggered.push({ check: rule.check, action: rule.action, severity: rule.severity ?? 'medium', evidence });

    if (rule.action === 'block') {
      verdict.blocked = true;
      verdict.action = 'block';
      verdict.reason = reason;
    } else if (rule.action === 'handoff') {
      verdict.handoff = true;
      if (verdict.action === 'allow' || verdict.action === 'flag' || verdict.action === 'mask') verdict.action = 'handoff';
      verdict.reason ??= reason;
    } else if (rule.action === 'mask' && verdict.action === 'allow') {
      verdict.action = 'mask';
    } else if (rule.action === 'flag' && verdict.action === 'allow') {
      verdict.action = 'flag';
      verdict.reason ??= reason;
    }
  }

  private async record(verdict: GuardrailVerdict, stage: GuardrailStage, context: GuardrailContext): Promise<void> {
    if (!verdict.triggered.length) return;
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return;

    for (const trigger of verdict.triggered) {
      this.metrics.guardrailBlocks.inc({ stage, check: trigger.check, action: trigger.action });
    }

    try {
      await this.prisma.raw.guardrailEvent.createMany({
        data: verdict.triggered.map((trigger) => ({
          id: newId('guardrailEvent'),
          organizationId,
          policyId: context.policyId ?? null,
          stage,
          check: trigger.check,
          action: trigger.action,
          severity: trigger.severity,
          subjectType: context.subjectType ?? null,
          subjectId: context.subjectId ?? null,
          executionId: context.executionId ?? null,
          conversationId: context.conversationId ?? null,
          detail: { evidence: trigger.evidence } as Prisma.InputJsonValue,
        })),
      });

      await this.events.publish(DomainEvent.GuardrailTriggered, { type: 'guardrail', id: context.executionId ?? organizationId }, {
        policy: context.policyId ?? 'default',
        action: verdict.action,
        severity: verdict.triggered[0]?.severity ?? 'medium',
        subjectId: context.subjectId,
      });
    } catch (error) {
      this.logger.error('Failed to record a guardrail event', error);
    }
  }

  // ── Policies ───────────────────────────────────────────────────────────────

  async listPolicies() {
    return this.prisma.db.guardrailPolicy.findMany({ where: {}, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  }

  async createPolicy(input: { name: string; description?: string; rules?: GuardrailRule[]; confidenceThreshold?: number; groundednessMode?: string; maskPii?: boolean; isDefault?: boolean }) {
    if (input.isDefault) await this.prisma.db.guardrailPolicy.updateMany({ where: {}, data: { isDefault: false } });
    const policy = await this.prisma.db.guardrailPolicy.create({
      data: {
        id: newId('guardrail'),
        name: input.name,
        description: input.description ?? null,
        rules: (input.rules ?? DEFAULT_RULES) as unknown as Prisma.InputJsonValue,
        confidenceThreshold: input.confidenceThreshold ?? 0.7,
        groundednessMode: input.groundednessMode ?? 'flag',
        maskPii: input.maskPii ?? true,
        isDefault: input.isDefault ?? false,
      } as never,
    });
    await this.invalidate(policy.id);
    return policy;
  }

  async updatePolicy(policyId: string, patch: Record<string, unknown>) {
    if (patch.isDefault) await this.prisma.db.guardrailPolicy.updateMany({ where: {}, data: { isDefault: false } });
    const policy = await this.prisma.db.guardrailPolicy.update({ where: { id: policyId }, data: patch as never });
    await this.invalidate(policyId);
    return policy;
  }

  async deletePolicy(policyId: string) {
    const policy = await this.prisma.db.guardrailPolicy.findFirst({ where: { id: policyId } });
    if (!policy) throw AppError.notFound('Guardrail policy', policyId);
    if (policy.isDefault) throw AppError.conflict('The default guardrail policy cannot be deleted');
    await this.prisma.db.guardrailPolicy.delete({ where: { id: policyId } });
    await this.invalidate(policyId);
  }

  private async invalidate(policyId: string) {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return;
    await this.redis.del(
      this.redis.key(organizationId, 'guardrail', policyId),
      this.redis.key(organizationId, 'guardrail', 'default'),
    );
  }

  async recentEvents(limit = 100) {
    return this.prisma.db.guardrailEvent.findMany({ where: {}, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 500) });
  }
}
