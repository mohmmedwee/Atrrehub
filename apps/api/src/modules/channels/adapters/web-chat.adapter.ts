import { Injectable } from '@nestjs/common';
import type { ChannelType } from '@prisma/client';
import type {
  ChannelAccountContext,
  ChannelAdapter,
  ChannelMetadata,
  DeliveryReceipt,
  NormalizedInboundMessage,
  OutboundMessage,
} from '../channel-adapter';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

interface WebChatPayload {
  sessionId: string;
  visitorId?: string;
  email?: string;
  displayName?: string;
  body: string;
  locale?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Web chat. Delivery is a WebSocket push rather than a provider call, so
 * "sent" here means the message reached the customer's open socket (or was
 * persisted for them to collect when they reconnect).
 */
@Injectable()
export class WebChatAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'web_chat';

  constructor(private readonly realtime: RealtimeGateway) {}

  async receive(payload: unknown, _account: ChannelAccountContext): Promise<NormalizedInboundMessage | null> {
    const input = payload as WebChatPayload;
    if (!input?.body?.trim()) return null;

    return {
      externalId: `wc_${input.sessionId}_${Date.now()}`,
      threadKey: `web_chat:${input.sessionId}`,
      contact: input.email
        ? { kind: 'email', value: input.email, displayName: input.displayName }
        : { kind: 'external', value: input.visitorId ?? input.sessionId, displayName: input.displayName ?? 'Website visitor' },
      body: input.body.trim(),
      locale: input.locale,
      metadata: { ...input.metadata, sessionId: input.sessionId },
      receivedAt: new Date(),
    };
  }

  async send(message: OutboundMessage, account: ChannelAccountContext): Promise<DeliveryReceipt> {
    const reached = this.realtime.emitToConversation(account.organizationId, message.conversationId, 'message', {
      messageId: message.messageId,
      body: message.body,
      bodyHtml: message.bodyHtml,
      metadata: message.metadata,
    });
    // The transcript is persisted either way; an offline visitor sees it on return.
    return { externalId: message.messageId, state: reached ? 'delivered' : 'sent' };
  }

  metadata(): ChannelMetadata {
    return {
      supportsAttachments: true,
      supportsRichText: true,
      supportsTypingIndicator: true,
      supportsReadReceipts: true,
      maxMessageLength: 8000,
    };
  }
}
