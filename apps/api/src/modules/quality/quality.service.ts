import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AiGateway } from '../ai/gateway.service';
import { ConversationsService } from '../conversations/conversations.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface CriterionInput {
  category: string;
  name: string;
  description?: string;
  weight: number;
  rubric: string;
  isCritical?: boolean;
}

/** The scorecard from the plan: greeting 10, accuracy 25, compliance 30, tone 15, resolution 10, closing 10. */
export const DEFAULT_QC_CRITERIA: CriterionInput[] = [
  {
    category: 'Greeting',
    name: 'Greeting',
    weight: 10,
    rubric: 'Did the agent greet the customer politely and identify themselves and the company?',
  },
  {
    category: 'Accuracy',
    name: 'Accuracy',
    weight: 25,
    rubric: 'Was every factual statement correct and consistent with company policy?',
  },
  {
    category: 'Compliance',
    name: 'Compliance',
    weight: 30,
    rubric: 'Did the agent follow required disclosures, verification and data-handling rules?',
    isCritical: true,
  },
  {
    category: 'Tone',
    name: 'Tone',
    weight: 15,
    rubric: 'Was the agent empathetic, professional and free of dismissive or defensive language?',
  },
  {
    category: 'Resolution',
    name: 'Resolution',
    weight: 10,
    rubric: 'Was the customer’s issue actually resolved, or a clear next step agreed?',
  },
  {
    category: 'Closing',
    name: 'Closing',
    weight: 10,
    rubric: 'Did the agent confirm resolution, offer further help and close courteously?',
  },
];

/**
 * AI quality management.
 *
 * Templates weight criteria to 100, each criterion is scored 0-100 against its
 * own rubric with cited evidence, and the overall score is the weighted mean.
 * A failed critical criterion caps the whole evaluation, because a compliance
 * breach is not something a good tone can average away.
 */
@Injectable()
export class QualityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGateway,
    private readonly conversations: ConversationsService,
    private readonly realtime: RealtimeGateway,
    private readonly events: EventBus,
    private readonly logger: AppLogger,
  ) {}

  // ── Templates ──────────────────────────────────────────────────────────────

  async listTemplates() {
    return this.prisma.db.qcTemplate.findMany({
      where: {},
      include: {
        criteria: { orderBy: { position: 'asc' } },
        _count: { select: { evaluations: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createTemplate(input: {
    name: string;
    description?: string;
    channels?: string[];
    autoEvaluate?: boolean;
    samplePercent?: number;
    passingScore?: number;
    criteria?: CriterionInput[];
  }) {
    const criteria = input.criteria?.length ? input.criteria : DEFAULT_QC_CRITERIA;
    const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
    if (total !== 100) {
      throw AppError.badRequest(`Criterion weights must total 100; they currently total ${total}`);
    }

    const organizationId = RequestContextStore.organizationId()!;
    const templateId = newId('qcTemplate');

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.qcTemplate.create({
        data: {
          id: templateId,
          organizationId,
          name: input.name,
          description: input.description ?? null,
          channels: (input.channels ?? []) as never,
          autoEvaluate: input.autoEvaluate ?? true,
          samplePercent: Math.min(Math.max(input.samplePercent ?? 100, 1), 100),
          passingScore: input.passingScore ?? 80,
        },
      });
      await tx.qcCriterion.createMany({
        data: criteria.map((criterion, index) => ({
          id: newId('qcCriterion'),
          organizationId,
          templateId,
          category: criterion.category,
          name: criterion.name,
          description: criterion.description ?? null,
          weight: criterion.weight,
          rubric: criterion.rubric,
          isCritical: criterion.isCritical ?? false,
          position: index,
        })),
      });
    });

    return this.getTemplate(templateId);
  }

  async getTemplate(templateId: string) {
    const template = await this.prisma.db.qcTemplate.findFirst({
      where: { id: templateId },
      include: { criteria: { orderBy: { position: 'asc' } } },
    });
    if (!template) throw AppError.notFound('QC template', templateId);
    return template;
  }

  async updateTemplate(templateId: string, patch: Record<string, unknown>) {
    return this.prisma.db.qcTemplate.update({ where: { id: templateId }, data: patch as never });
  }

  async deleteTemplate(templateId: string) {
    await this.prisma.db.qcTemplate.delete({ where: { id: templateId } });
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  /**
   * Score a conversation against a template. One model call scores every
   * criterion together, so the evaluator sees the whole interaction rather than
   * judging each dimension in isolation.
   */
  async evaluateConversation(conversationId: string, templateId?: string) {
    const conversation = await this.conversations.get(conversationId);
    const messages = await this.conversations.listMessages(conversationId, { limit: 200 });

    const template = templateId
      ? await this.getTemplate(templateId)
      : await this.prisma.db.qcTemplate.findFirst({
          where: {
            isActive: true,
            OR: [{ channels: { isEmpty: true } }, { channels: { has: conversation.channel } }],
          },
          include: { criteria: { orderBy: { position: 'asc' } } },
        });
    if (!template) throw AppError.notFound('An applicable QC template');

    const transcript = messages.data
      .filter((message) => !message.isPrivate)
      .map(
        (message, index) =>
          `[${index + 1}] ${message.authorType === 'customer' ? 'Customer' : 'Agent'}: ${message.body}`,
      )
      .join('\n');

    if (!transcript.trim())
      throw AppError.badRequest('The conversation has no messages to evaluate');

    const { value, response } = await this.gateway.completeStructured<{
      scores: { criterion: string; score: number; reasoning: string; evidence: string[] }[];
      strengths: string[];
      improvements: string[];
      reasoning: string;
    }>(
      {
        messages: [
          {
            role: 'system',
            content: [
              'You are a contact centre quality evaluator. Score the agent against each criterion from 0 to 100.',
              'Cite the message numbers that justify each score as evidence. Be specific and fair.',
              '',
              'Criteria:',
              ...template.criteria.map(
                (criterion) =>
                  `- ${criterion.name} (weight ${criterion.weight}%): ${criterion.rubric}`,
              ),
            ].join('\n'),
          },
          { role: 'user', content: transcript },
        ],
        responseSchema: {
          type: 'object',
          properties: {
            scores: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  criterion: { type: 'string', enum: template.criteria.map((c) => c.name) },
                  score: { type: 'number' },
                  reasoning: { type: 'string' },
                  evidence: { type: 'array', items: { type: 'string' } },
                },
                required: ['criterion', 'score'],
              },
            },
            strengths: { type: 'array', items: { type: 'string' } },
            improvements: { type: 'array', items: { type: 'string' } },
            reasoning: { type: 'string', description: 'A short summary of the evaluation' },
          },
          required: ['scores'],
        },
      },
      { role: 'reasoning', operation: 'qc.evaluate', conversationId },
    );

    const byName = new Map(value.scores?.map((entry) => [entry.criterion, entry]) ?? []);
    const scored = template.criteria.map((criterion) => {
      const entry = byName.get(criterion.name);
      return {
        criterion,
        score: clamp(Number(entry?.score ?? 0), 0, 100),
        reasoning: entry?.reasoning ?? null,
        evidence: entry?.evidence ?? [],
      };
    });

    const weighted = scored.reduce(
      (total, entry) => total + (entry.score * entry.criterion.weight) / 100,
      0,
    );

    // A failed critical criterion caps the total — a compliance breach cannot
    // be averaged away by a warm greeting.
    const failedCritical = scored.filter((entry) => entry.criterion.isCritical && entry.score < 50);
    const overall = failedCritical.length ? Math.min(weighted, 49) : weighted;

    const organizationId = RequestContextStore.organizationId()!;
    const evaluationId = newId('qcEvaluation');

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.qcEvaluation.create({
        data: {
          id: evaluationId,
          organizationId,
          templateId: template.id,
          conversationId,
          subjectType: conversation.assigneeType === 'ai_agent' ? 'ai_agent' : 'user',
          subjectId: conversation.assigneeId,
          kind: 'ai',
          score: Math.round(overall * 10) / 10,
          passed: overall >= template.passingScore,
          reasoning: value.reasoning ?? null,
          strengths: value.strengths ?? [],
          improvements: value.improvements ?? [],
          model: response.model,
        },
      });
      await tx.qcCriterionScore.createMany({
        data: scored.map((entry) => ({
          id: newId('qcScore'),
          organizationId,
          evaluationId,
          criterionId: entry.criterion.id,
          score: entry.score,
          reasoning: entry.reasoning,
          evidence: entry.evidence as unknown as Prisma.InputJsonValue,
        })),
      });
    });

    await this.events.publish(
      DomainEvent.QcEvaluated,
      { type: 'conversation', id: conversationId },
      {
        evaluationId,
        subjectId: conversation.assigneeId,
        score: Math.round(overall * 10) / 10,
        templateId: template.id,
      },
    );

    return this.getEvaluation(evaluationId);
  }

  async getEvaluation(evaluationId: string) {
    const evaluation = await this.prisma.db.qcEvaluation.findFirst({
      where: { id: evaluationId },
      include: {
        template: { select: { id: true, name: true, passingScore: true } },
        scores: {
          include: {
            criterion: { select: { name: true, category: true, weight: true, isCritical: true } },
          },
        },
        disputes: true,
      },
    });
    if (!evaluation) throw AppError.notFound('Evaluation', evaluationId);
    return evaluation;
  }

  async listEvaluations(params: {
    subjectId?: string;
    templateId?: string;
    passed?: boolean;
    limit?: number;
  }) {
    return this.prisma.db.qcEvaluation.findMany({
      where: {
        ...(params.subjectId ? { subjectId: params.subjectId } : {}),
        ...(params.templateId ? { templateId: params.templateId } : {}),
        ...(params.passed !== undefined ? { passed: params.passed } : {}),
      },
      include: { template: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(params.limit ?? 50, 200),
    });
  }

  /** A human evaluation, which overrides the AI score for the same interaction. */
  async manualEvaluation(input: {
    conversationId: string;
    templateId: string;
    scores: { criterionId: string; score: number; reasoning?: string }[];
    reasoning?: string;
    strengths?: string[];
    improvements?: string[];
  }) {
    const template = await this.getTemplate(input.templateId);
    const organizationId = RequestContextStore.organizationId()!;
    const principal = RequestContextStore.principal();

    const byId = new Map(input.scores.map((entry) => [entry.criterionId, entry]));
    const weighted = template.criteria.reduce((total, criterion) => {
      const entry = byId.get(criterion.id);
      return total + (clamp(Number(entry?.score ?? 0), 0, 100) * criterion.weight) / 100;
    }, 0);

    const conversation = await this.conversations.get(input.conversationId);
    const evaluationId = newId('qcEvaluation');

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.qcEvaluation.create({
        data: {
          id: evaluationId,
          organizationId,
          templateId: template.id,
          conversationId: input.conversationId,
          subjectType: conversation.assigneeType === 'ai_agent' ? 'ai_agent' : 'user',
          subjectId: conversation.assigneeId,
          kind: 'manual',
          score: Math.round(weighted * 10) / 10,
          passed: weighted >= template.passingScore,
          reasoning: input.reasoning ?? null,
          strengths: input.strengths ?? [],
          improvements: input.improvements ?? [],
          evaluatorId: principal?.id ?? null,
        },
      });
      await tx.qcCriterionScore.createMany({
        data: template.criteria.map((criterion) => ({
          id: newId('qcScore'),
          organizationId,
          evaluationId,
          criterionId: criterion.id,
          score: clamp(Number(byId.get(criterion.id)?.score ?? 0), 0, 100),
          reasoning: byId.get(criterion.id)?.reasoning ?? null,
        })),
      });
    });

    return this.getEvaluation(evaluationId);
  }

  // ── Disputes ───────────────────────────────────────────────────────────────

  async raiseDispute(evaluationId: string, reason: string) {
    const principal = RequestContextStore.principal();
    const dispute = await this.prisma.db.qcDispute.create({
      data: {
        id: newId('qcDispute'),
        evaluationId,
        raisedById: principal?.id ?? 'unknown',
        reason,
      } as never,
    });
    await this.prisma.db.qcEvaluation.update({
      where: { id: evaluationId },
      data: { status: 'disputed' },
    });
    await this.events.publish(
      DomainEvent.QcDisputed,
      { type: 'qc_evaluation', id: evaluationId },
      { evaluationId, reason },
    );
    return dispute;
  }

  async resolveDispute(disputeId: string, input: { resolution: string; resolvedScore?: number }) {
    const principal = RequestContextStore.principal();
    const dispute = await this.prisma.db.qcDispute.update({
      where: { id: disputeId },
      data: {
        status: 'resolved',
        resolution: input.resolution,
        resolvedScore: input.resolvedScore ?? null,
        resolvedById: principal?.id ?? null,
        resolvedAt: new Date(),
      },
    });

    if (input.resolvedScore !== undefined) {
      const evaluation = await this.prisma.db.qcEvaluation.findFirst({
        where: { id: dispute.evaluationId },
        include: { template: { select: { passingScore: true } } },
      });
      await this.prisma.db.qcEvaluation.update({
        where: { id: dispute.evaluationId },
        data: {
          score: input.resolvedScore,
          passed: input.resolvedScore >= (evaluation?.template.passingScore ?? 80),
          status: 'final',
        },
      });
    } else {
      await this.prisma.db.qcEvaluation.update({
        where: { id: dispute.evaluationId },
        data: { status: 'final' },
      });
    }

    return dispute;
  }

  /**
   * Calibration: how far each evaluator's manual scores sit from the AI
   * baseline on the same conversations. Persistent drift means the rubric or
   * the evaluator needs attention, not the agents.
   */
  async calibration(templateId: string) {
    const evaluations = await this.prisma.db.qcEvaluation.findMany({
      where: { templateId },
      select: { conversationId: true, kind: true, score: true, evaluatorId: true },
    });

    const byConversation = new Map<
      string,
      { ai?: number; manual: { evaluatorId: string | null; score: number }[] }
    >();
    for (const evaluation of evaluations) {
      if (!evaluation.conversationId) continue;
      const entry = byConversation.get(evaluation.conversationId) ?? { manual: [] };
      if (evaluation.kind === 'ai') entry.ai = evaluation.score;
      else entry.manual.push({ evaluatorId: evaluation.evaluatorId, score: evaluation.score });
      byConversation.set(evaluation.conversationId, entry);
    }

    const drift = new Map<string, number[]>();
    for (const entry of byConversation.values()) {
      if (entry.ai === undefined) continue;
      for (const manual of entry.manual) {
        const key = manual.evaluatorId ?? 'unknown';
        drift.set(key, [...(drift.get(key) ?? []), manual.score - entry.ai]);
      }
    }

    return [...drift.entries()].map(([evaluatorId, deltas]) => ({
      evaluatorId,
      samples: deltas.length,
      averageDelta:
        Math.round((deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length) * 10) / 10,
      maxDelta: Math.round(Math.max(...deltas.map(Math.abs)) * 10) / 10,
    }));
  }

  // ── Real-time quality ──────────────────────────────────────────────────────

  /**
   * Watch a live conversation for compliance, tone and frustration signals.
   *
   * Runs on the newest turns only: the value of a real-time signal is that it
   * arrives while the agent can still act on it.
   */
  async monitorLive(conversationId: string, messageId?: string) {
    const messages = await this.conversations.listMessages(conversationId, { limit: 8 });
    if (messages.data.length < 2) return { signals: [] };

    const recent = messages.data
      .map(
        (message) => `${message.authorType === 'customer' ? 'Customer' : 'Agent'}: ${message.body}`,
      )
      .join('\n');

    const { value } = await this.gateway.completeStructured<{
      signals: { signal: string; severity: string; message: string; guidance: string }[];
    }>(
      {
        messages: [
          {
            role: 'system',
            content:
              'Watch this live support conversation. Report only signals that need the agent to act now: a compliance risk, a missing required statement, a dismissive tone, rising customer frustration, or missing information. Return an empty list when nothing needs attention.',
          },
          { role: 'user', content: recent },
        ],
        responseSchema: {
          type: 'object',
          properties: {
            signals: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  signal: {
                    type: 'string',
                    enum: [
                      'compliance',
                      'tone',
                      'frustration',
                      'missing_information',
                      'required_statement',
                      'agent_behaviour',
                    ],
                  },
                  severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
                  message: { type: 'string' },
                  guidance: { type: 'string' },
                },
                required: ['signal', 'severity', 'message'],
              },
            },
          },
          required: ['signals'],
        },
      },
      { role: 'fast', operation: 'qc.realtime', conversationId },
    );

    const organizationId = RequestContextStore.organizationId()!;
    const signals = (value.signals ?? []).filter((signal) => signal.severity !== 'info');
    if (!signals.length) return { signals: [] };

    await this.prisma.raw.realtimeSignal.createMany({
      data: signals.map((signal) => ({
        id: newId('signal'),
        organizationId,
        conversationId,
        signal: signal.signal,
        severity: signal.severity,
        message: signal.message,
        guidance: signal.guidance ?? null,
        messageId: messageId ?? null,
      })),
    });

    // Push to the agent immediately — a signal delivered after the conversation
    // ends is a report, not guidance.
    for (const signal of signals) {
      this.realtime.emitToConversation(organizationId, conversationId, 'qc:signal', signal);
      await this.events.publish(
        DomainEvent.QcRealtimeAlert,
        { type: 'conversation', id: conversationId },
        {
          conversationId,
          signal: signal.signal,
          severity: signal.severity,
        },
      );
    }

    this.logger.debug('Real-time quality signals raised', {
      conversationId,
      count: signals.length,
    });
    return { signals };
  }

  async listSignals(conversationId: string) {
    return this.prisma.db.realtimeSignal.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async acknowledgeSignal(signalId: string) {
    const principal = RequestContextStore.principal();
    return this.prisma.db.realtimeSignal.update({
      where: { id: signalId },
      data: { acknowledgedBy: principal?.id ?? null, acknowledgedAt: new Date() },
    });
  }

  /** Should this conversation be evaluated, given the template's sampling rate? */
  async shouldSample(templateId: string): Promise<boolean> {
    const template = await this.prisma.db.qcTemplate.findFirst({ where: { id: templateId } });
    if (!template?.autoEvaluate) return false;
    return Math.random() * 100 < template.samplePercent;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
