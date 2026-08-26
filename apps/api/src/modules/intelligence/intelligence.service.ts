import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../../core/context/request-context';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AiGateway } from '../ai/gateway.service';
import { ConversationsService } from '../conversations/conversations.service';

/**
 * Conversation intelligence: turns transcripts into structured signals that
 * routing, automation, QC and analytics can all act on.
 */
@Injectable()
export class IntelligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGateway,
    private readonly conversations: ConversationsService,
    private readonly events: EventBus,
    private readonly logger: AppLogger,
  ) {}

  async extract(conversationId: string) {
    const conversation = await this.conversations.get(conversationId);
    const messages = await this.conversations.listMessages(conversationId, { limit: 100 });

    const transcript = messages.data
      .filter((message) => !message.isPrivate)
      .map(
        (message) => `${message.authorType === 'customer' ? 'Customer' : 'Agent'}: ${message.body}`,
      )
      .join('\n');
    if (!transcript.trim()) return null;

    const { value, response } = await this.gateway.completeStructured<{
      intent: string;
      intentConfidence: number;
      sentiment: string;
      sentimentScore: number;
      sentimentTrend: string;
      topics: string[];
      entities: { type: string; value: string }[];
      products: string[];
      complaints: string[];
      reasons: string[];
      churnRisk: number;
      preferences: Record<string, unknown>;
      summary: string;
      resolutionType: string;
    }>(
      {
        messages: [
          {
            role: 'system',
            content:
              'Extract structured intelligence from this support conversation. sentimentScore ranges -1 to 1, churnRisk 0 to 1. Report only what the transcript supports.',
          },
          { role: 'user', content: transcript },
        ],
        responseSchema: {
          type: 'object',
          properties: {
            intent: { type: 'string' },
            intentConfidence: { type: 'number' },
            sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
            sentimentScore: { type: 'number' },
            sentimentTrend: { type: 'string', enum: ['improving', 'stable', 'declining'] },
            topics: { type: 'array', items: { type: 'string' } },
            entities: {
              type: 'array',
              items: {
                type: 'object',
                properties: { type: { type: 'string' }, value: { type: 'string' } },
              },
            },
            products: { type: 'array', items: { type: 'string' } },
            complaints: { type: 'array', items: { type: 'string' } },
            reasons: { type: 'array', items: { type: 'string' } },
            churnRisk: { type: 'number' },
            preferences: { type: 'object', properties: {} },
            summary: { type: 'string', description: 'A short summary of the conversation' },
            resolutionType: {
              type: 'string',
              enum: ['resolved', 'escalated', 'pending', 'abandoned'],
            },
          },
          required: ['intent', 'sentiment'],
        },
      },
      { role: 'fast', operation: 'intelligence.extract', conversationId },
    );

    const organizationId = RequestContextStore.organizationId()!;
    const sentimentScore = clamp(Number(value.sentimentScore ?? 0), -1, 1);
    const churnRisk = clamp(Number(value.churnRisk ?? 0), 0, 1);

    const intelligence = await this.prisma.db.conversationIntelligence.upsert({
      where: { conversationId },
      create: {
        id: newId('intelligence'),
        organizationId,
        conversationId,
        intent: value.intent,
        intentConfidence: clamp(Number(value.intentConfidence ?? 0.5), 0, 1),
        sentiment: value.sentiment,
        sentimentScore,
        sentimentTrend: value.sentimentTrend,
        topics: value.topics ?? [],
        entities: (value.entities ?? []) as never,
        products: value.products ?? [],
        complaints: value.complaints ?? [],
        reasons: value.reasons ?? [],
        churnRisk,
        preferences: (value.preferences ?? {}) as never,
        summary: value.summary,
        resolutionType: value.resolutionType,
        model: response.model,
      } as never,
      update: {
        intent: value.intent,
        intentConfidence: clamp(Number(value.intentConfidence ?? 0.5), 0, 1),
        sentiment: value.sentiment,
        sentimentScore,
        sentimentTrend: value.sentimentTrend,
        topics: value.topics ?? [],
        entities: (value.entities ?? []) as never,
        products: value.products ?? [],
        complaints: value.complaints ?? [],
        reasons: value.reasons ?? [],
        churnRisk,
        preferences: (value.preferences ?? {}) as never,
        summary: value.summary,
        resolutionType: value.resolutionType,
        model: response.model,
      },
    });

    await this.events.publish(
      DomainEvent.IntelExtracted,
      { type: 'conversation', id: conversationId },
      {
        conversationId,
        intent: value.intent,
        sentiment: value.sentiment,
        topics: value.topics ?? [],
      },
    );

    // Sentiment on the conversation is what routing and automation read.
    void conversation;
    return intelligence;
  }

  async get(conversationId: string) {
    return this.prisma.db.conversationIntelligence.findFirst({ where: { conversationId } });
  }

  /** How intents, topics and sentiment move over a period. */
  async trends(params: { from: Date; to: Date }) {
    const rows = await this.prisma.db.conversationIntelligence.findMany({
      where: { createdAt: { gte: params.from, lte: params.to } },
      select: {
        intent: true,
        sentiment: true,
        sentimentScore: true,
        topics: true,
        complaints: true,
        churnRisk: true,
        resolutionType: true,
      },
    });

    const count = <T extends string>(values: T[]) => {
      const map = new Map<T, number>();
      for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
      return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, total]) => ({ value, count: total }));
    };

    return {
      conversations: rows.length,
      intents: count(rows.map((row) => row.intent ?? 'unknown')).slice(0, 20),
      topics: count(rows.flatMap((row) => row.topics)).slice(0, 20),
      complaints: count(rows.flatMap((row) => row.complaints)).slice(0, 20),
      sentiment: count(rows.map((row) => row.sentiment ?? 'unknown')),
      resolutionTypes: count(rows.map((row) => row.resolutionType ?? 'unknown')),
      averageSentiment: rows.length
        ? Math.round(
            (rows.reduce((total, row) => total + (row.sentimentScore ?? 0), 0) / rows.length) * 100,
          ) / 100
        : 0,
      atRiskCount: rows.filter((row) => (row.churnRisk ?? 0) > 0.6).length,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
