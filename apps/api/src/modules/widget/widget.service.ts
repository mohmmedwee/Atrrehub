import { Injectable } from '@nestjs/common';
import { AppError } from '../../core/errors/app-error';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AgentsService } from '../agents/agents.service';
import { ChannelsService } from '../channels/channels.service';
import { ConversationsService } from '../conversations/conversations.service';

export interface WidgetAccount {
  id: string;
  organizationId: string;
  workspaceId: string | null;
  queueId: string | null;
  config: Record<string, unknown>;
}

/**
 * The widget's server side.
 *
 * A visitor's session id is the only credential they hold, so every read is
 * checked against the participant record for that session — a conversation id
 * alone must never be enough to read someone else's transcript.
 */
@Injectable()
export class WidgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelsService,
    private readonly conversations: ConversationsService,
    private readonly agents: AgentsService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Resolve the widget key to a channel account. With no key configured the
   * first active web-chat account is used, which is what makes the local
   * development experience work without setup.
   */
  async resolveAccount(widgetKey: string | undefined): Promise<WidgetAccount> {
    const account = widgetKey
      ? await this.prisma.raw.channelAccount.findFirst({
          where: { channel: 'web_chat', isActive: true, config: { path: ['widgetKey'], equals: widgetKey } },
        })
      : await this.prisma.raw.channelAccount.findFirst({
          where: { channel: 'web_chat', isActive: true },
          orderBy: { createdAt: 'asc' },
        });

    if (!account) throw AppError.notFound('Widget');
    return {
      id: account.id,
      organizationId: account.organizationId,
      workspaceId: account.workspaceId,
      queueId: account.queueId,
      config: (account.config ?? {}) as Record<string, unknown>,
    };
  }

  async config(account: WidgetAccount) {
    const organization = await this.prisma.raw.organization.findUniqueOrThrow({
      where: { id: account.organizationId },
      select: { name: true, logoUrl: true, primaryColor: true, defaultLanguage: true },
    });
    return {
      title: (account.config.title as string) ?? organization.name,
      greeting: (account.config.greeting as string) ?? 'Hello! How can we help today?',
      accent: organization.primaryColor ?? '#2563eb',
      logoUrl: organization.logoUrl,
      locale: organization.defaultLanguage,
    };
  }

  /**
   * Accept a visitor message. If the queue is AI-first the agent answers
   * inline so the visitor sees a reply immediately; otherwise the conversation
   * is queued for a human and the widget says so.
   */
  async receive(
    account: WidgetAccount,
    input: { sessionId: string; body: string; conversationId?: string; email?: string; displayName?: string; locale?: string },
  ) {
    const result = await this.channels.acceptInbound(
      'web_chat',
      {
        externalId: `wc_${input.sessionId}_${Date.now()}`,
        threadKey: `web_chat:${input.sessionId}`,
        contact: input.email
          ? { kind: 'email', value: input.email, displayName: input.displayName }
          : { kind: 'external', value: input.sessionId, displayName: input.displayName ?? 'Website visitor' },
        body: input.body,
        locale: input.locale,
        metadata: { sessionId: input.sessionId },
      },
      account.id,
      account.queueId ?? undefined,
      account.workspaceId ?? undefined,
    );

    const conversation = await this.conversations.get(result.conversationId);

    // Only answer inline when an AI agent actually owns this conversation.
    if (conversation.assigneeType === 'ai_agent' && conversation.assigneeId) {
      try {
        await this.agents.run({
          agentId: conversation.assigneeId,
          message: input.body,
          conversationId: conversation.id,
          customerId: conversation.customerId ?? undefined,
        });

        const messages = await this.conversations.listMessages(conversation.id, { limit: 5 });
        const reply = [...messages.data].reverse().find((message) => message.direction === 'outbound');

        if (reply) {
          return {
            conversationId: conversation.id,
            reply: reply.body,
            citations: reply.citations,
            queued: false,
          };
        }
      } catch (error) {
        // A failed AI turn must still leave the visitor with a working chat.
        this.logger.error('The AI agent could not answer a widget message', error, { conversationId: conversation.id });
      }
    }

    return { conversationId: conversation.id, reply: null, queued: true };
  }

  /** The visitor's own transcript, with internal notes withheld. */
  async transcript(conversationId: string, sessionId: string) {
    const conversation = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId, threadKey: `web_chat:${sessionId}` },
      select: { id: true },
    });
    // Mismatched session and conversation is reported as missing, not forbidden.
    if (!conversation) throw AppError.notFound('Conversation', conversationId);

    const messages = await this.conversations.listMessages(conversationId, { limit: 100, includePrivate: false });
    return {
      data: messages.data
        .filter((message) => !message.isPrivate && message.type !== 'note')
        .map((message) => ({
          id: message.id,
          direction: message.direction,
          body: message.body,
          citations: message.citations,
          createdAt: message.createdAt,
        })),
    };
  }
}
