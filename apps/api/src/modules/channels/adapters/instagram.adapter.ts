import { Injectable } from '@nestjs/common';
import type { ChannelType } from '@prisma/client';
import { AppLogger } from '../../../core/logger/logger.service';
import type {
  ChannelMetadata,
  NormalizedInboundMessage,
  OutboundMessage,
} from '../channel-adapter';
import { MetaMessagingAdapter, type MetaEntry } from './meta-base.adapter';

/**
 * Instagram direct messages.
 *
 * The webhook envelope is Messenger's, but a story reply or a mention arrives
 * with no text and would otherwise become an empty message in the agent's
 * inbox — so it is given a readable placeholder instead.
 */
@Injectable()
export class InstagramAdapter extends MetaMessagingAdapter {
  readonly channel: ChannelType = 'instagram';

  constructor(logger: AppLogger) {
    super(logger);
  }

  protected contactKind(): NormalizedInboundMessage['contact']['kind'] {
    return 'external';
  }

  protected extractEntries(payload: unknown): MetaEntry[] {
    const body = (payload ?? {}) as {
      entry?: {
        messaging?: {
          sender?: { id?: string; username?: string };
          recipient?: { id?: string };
          timestamp?: number;
          message?: {
            mid?: string;
            text?: string;
            is_echo?: boolean;
            reply_to?: { story?: { id?: string } };
            attachments?: { type?: string; payload?: { url?: string } }[];
          };
        }[];
      }[];
    };

    const entries: MetaEntry[] = [];
    for (const entry of body.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        const message = event.message;
        if (!message?.mid || !event.sender?.id || message.is_echo) continue;

        const isStoryReply = Boolean(message.reply_to?.story?.id);
        const attachments = message.attachments ?? [];

        entries.push({
          messageId: message.mid,
          senderId: event.sender.id,
          recipientId: event.recipient?.id ?? '',
          senderName: event.sender.username,
          timestamp: event.timestamp ? Math.floor(event.timestamp / 1000) : undefined,
          text:
            message.text ??
            (isStoryReply
              ? '(replied to your story)'
              : attachments.length
                ? `(sent ${attachments.length} attachment${attachments.length > 1 ? 's' : ''})`
                : undefined),
          attachments: attachments.map((attachment) => ({
            type: attachment.type ?? 'image',
            url: attachment.payload?.url,
          })),
        });
      }
    }
    return entries;
  }

  protected sendBody(message: OutboundMessage): Record<string, unknown> {
    return {
      recipient: { id: message.to },
      message: { text: message.body.slice(0, 1000) },
    };
  }

  override metadata(): ChannelMetadata {
    // Instagram gives a business 7 days to reply to a direct message.
    return { ...super.metadata(), maxMessageLength: 1000, sessionWindowHours: 24 * 7 };
  }
}
