import { Injectable } from '@nestjs/common';
import { AppError } from '../../core/errors/app-error';
import { AiGateway } from '../ai/gateway.service';
import { estimateCostUsd } from '../ai/provider';
import { ConversationsService } from '../conversations/conversations.service';
import { CustomersService } from '../customers/customers.service';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RagService } from '../rag/rag.service';

export type CopilotAction =
  | 'suggest_reply'
  | 'rewrite'
  | 'summarize'
  | 'translate'
  | 'adjust_tone'
  | 'next_best_action'
  | 'customer_summary';

export interface CopilotRequest {
  conversationId: string;
  action: CopilotAction;
  /** The agent's draft, for rewrite and tone actions. */
  draft?: string;
  targetLocale?: string;
  tone?: 'formal' | 'friendly' | 'concise' | 'empathetic' | 'apologetic';
}

/**
 * Agent assist.
 *
 * Every suggestion is grounded in the same knowledge the AI agent uses and
 * passes the same output guardrails, so a copilot suggestion cannot leak what
 * an autonomous answer would have been blocked from saying.
 */
@Injectable()
export class CopilotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGateway,
    private readonly rag: RagService,
    private readonly knowledge: KnowledgeService,
    private readonly guardrails: GuardrailsService,
    private readonly conversations: ConversationsService,
    private readonly customers: CustomersService,
  ) {}

  async assist(request: CopilotRequest) {
    const conversation = await this.conversations.get(request.conversationId);
    const messages = await this.conversations.listMessages(request.conversationId, { limit: 30 });

    const transcript = messages.data
      .map((message) => `${message.authorType === 'customer' ? 'Customer' : 'Agent'}: ${message.body}`)
      .join('\n');
    const lastCustomerMessage = [...messages.data].reverse().find((message) => message.direction === 'inbound')?.body ?? '';

    switch (request.action) {
      case 'suggest_reply':
        return this.suggestReply(request, transcript, lastCustomerMessage, conversation.locale);
      case 'rewrite':
        return this.transform(request, 'Rewrite the agent draft so it is clear, correct and professional. Keep every fact unchanged.');
      case 'adjust_tone':
        return this.transform(request, `Rewrite the agent draft in a ${request.tone ?? 'friendly'} tone. Keep every fact unchanged.`);
      case 'translate':
        return this.transform(request, `Translate the agent draft into ${request.targetLocale ?? 'English'}. Preserve meaning, names and numbers exactly.`);
      case 'summarize':
        return this.summarize(transcript);
      case 'next_best_action':
        return this.nextBestAction(transcript, conversation);
      case 'customer_summary':
        return this.customerSummary(conversation.customerId);
      default:
        throw AppError.badRequest(`Unknown copilot action "${request.action}"`);
    }
  }

  /** A grounded reply suggestion, with the sources the agent can verify. */
  private async suggestReply(request: CopilotRequest, transcript: string, question: string, locale: string) {
    const scope = await this.knowledge.readableBaseIds();
    const hits = await this.rag.retrieve(question || transcript.slice(-2000), {
      knowledgeBaseIds: scope,
      topK: 5,
      conversationId: request.conversationId,
    });
    const { context, citations } = this.rag.buildContext(hits);

    const response = await this.gateway.complete(
      {
        messages: [
          {
            role: 'system',
            content: `You are helping a human support agent write their next reply. Draft a reply they can send, in ${locale}. Use only the context provided; if it does not contain the answer, say what the agent should ask or check instead.\n\n<context>\n${context}\n</context>`,
          },
          { role: 'user', content: `Conversation so far:\n${transcript}\n\nDraft the agent's next reply.` },
        ],
        temperature: 0.3,
      },
      { role: 'chat', operation: 'copilot.suggest_reply', conversationId: request.conversationId },
    );

    const groundedness = this.rag.groundedness(response.content, hits);
    const verdict = await this.guardrails.checkOutput(response.content, {
      conversationId: request.conversationId,
      groundedness,
    });

    return {
      action: 'suggest_reply' as const,
      suggestion: verdict.text,
      citations,
      groundedness: groundedness.score,
      confidence: response.confidence,
      warnings: verdict.triggered.map((trigger) => trigger.check),
      usage: this.usage(response),
    };
  }

  private async transform(request: CopilotRequest, instruction: string) {
    if (!request.draft?.trim()) throw AppError.badRequest('A draft is required for this action');

    const response = await this.gateway.complete(
      {
        messages: [
          { role: 'system', content: `${instruction} Reply with the rewritten text only.` },
          { role: 'user', content: request.draft },
        ],
        temperature: 0.2,
      },
      { role: 'fast', operation: `copilot.${request.action}`, conversationId: request.conversationId },
    );

    const verdict = await this.guardrails.checkOutput(response.content, { conversationId: request.conversationId });
    return { action: request.action, suggestion: verdict.text, warnings: verdict.triggered.map((t) => t.check), usage: this.usage(response) };
  }

  private async summarize(transcript: string) {
    const { value, response } = await this.gateway.completeStructured<{
      summary: string;
      keyPoints: string[];
      openQuestions: string[];
    }>(
      {
        messages: [
          { role: 'system', content: 'Summarize this support conversation for a colleague picking it up.' },
          { role: 'user', content: transcript },
        ],
        responseSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'A short summary of the conversation' },
            keyPoints: { type: 'array', items: { type: 'string' } },
            openQuestions: { type: 'array', items: { type: 'string' } },
          },
          required: ['summary'],
        },
      },
      { role: 'fast', operation: 'copilot.summarize' },
    );

    return { action: 'summarize' as const, ...value, usage: this.usage(response) };
  }

  private async nextBestAction(transcript: string, conversation: Awaited<ReturnType<ConversationsService['get']>>) {
    const { value, response } = await this.gateway.completeStructured<{
      action: string;
      reason: string;
      urgency: string;
    }>(
      {
        messages: [
          {
            role: 'system',
            content: 'Recommend the single next action the support agent should take. Consider whether to reply, escalate, open a ticket, or resolve.',
          },
          {
            role: 'user',
            content: `Status: ${conversation.status}, priority: ${conversation.priority}, channel: ${conversation.channel}.\n\n${transcript}`,
          },
        ],
        responseSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['reply', 'ask_for_information', 'create_ticket', 'escalate', 'transfer', 'resolve'] },
            reason: { type: 'string' },
            urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
          },
          required: ['action', 'reason'],
        },
      },
      { role: 'fast', operation: 'copilot.next_best_action', conversationId: conversation.id },
    );

    return { action: 'next_best_action' as const, recommendation: value, usage: this.usage(response) };
  }

  /**
   * The AI customer context shown in the workspace rail. Cached on the customer
   * so opening a conversation does not pay for a generation every time.
   */
  async customerSummary(customerId: string | null | undefined, force = false) {
    if (!customerId) return { action: 'customer_summary' as const, context: null };

    const existing = await this.prisma.db.customerAiContext.findFirst({ where: { customerId } });
    const fresh = existing && Date.now() - existing.generatedAt.getTime() < 3_600_000;
    if (fresh && !force) return { action: 'customer_summary' as const, context: existing, cached: true };

    const overview = await this.customers.overview(customerId);
    const history = [
      ...overview.conversations.map((c) => `Conversation ${c.reference} (${c.channel}, ${c.status}): ${c.subject ?? 'no subject'}`),
      ...overview.tickets.map((t) => `Ticket ${t.reference} (${t.status}): ${t.subject}`),
    ].join('\n');

    const { value, response } = await this.gateway.completeStructured<{
      summary: string;
      intent: string;
      sentiment: string;
      topics: string[];
      customerType: string;
      riskLevel: string;
      currentIssue: string;
    }>(
      {
        messages: [
          { role: 'system', content: 'Summarize what a support agent needs to know about this customer before responding.' },
          {
            role: 'user',
            content: `Customer: ${overview.customer.displayName}, tier ${overview.customer.tier ?? 'none'}, company ${overview.customer.company ?? 'none'}.\n\nHistory:\n${history || 'No previous history.'}`,
          },
        ],
        responseSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'A short summary of this customer' },
            intent: { type: 'string' },
            sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
            topics: { type: 'array', items: { type: 'string' } },
            customerType: { type: 'string' },
            riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
            currentIssue: { type: 'string' },
          },
          required: ['summary'],
        },
      },
      { role: 'fast', operation: 'copilot.customer_summary' },
    );

    const context = await this.prisma.db.customerAiContext.upsert({
      where: { customerId },
      create: {
        id: `ctx_${customerId.slice(4)}`,
        customerId,
        summary: value.summary,
        intent: value.intent,
        sentiment: value.sentiment,
        topics: value.topics ?? [],
        customerType: value.customerType,
        riskLevel: value.riskLevel,
        currentIssue: value.currentIssue,
        model: response.model,
      } as never,
      update: {
        summary: value.summary,
        intent: value.intent,
        sentiment: value.sentiment,
        topics: value.topics ?? [],
        customerType: value.customerType,
        riskLevel: value.riskLevel,
        currentIssue: value.currentIssue,
        model: response.model,
        generatedAt: new Date(),
      },
    });

    return { action: 'customer_summary' as const, context, cached: false, usage: this.usage(response) };
  }

  private usage(response: { usage: { promptTokens: number; completionTokens: number }; model: string }) {
    return {
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      costUsd: estimateCostUsd(response.model, response.usage.promptTokens, response.usage.completionTokens),
      model: response.model,
    };
  }
}
