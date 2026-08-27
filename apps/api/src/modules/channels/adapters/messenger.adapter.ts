import { Injectable } from '@nestjs/common';
import type { ChannelType } from '@prisma/client';
import { AppLogger } from '../../../core/logger/logger.service';
import type { NormalizedInboundMessage, OutboundMessage } from '../channel-adapter';
import { MetaMessagingAdapter, type MetaEntry } from './meta-base.adapter';

/** Facebook Messenger, over the same Graph API as WhatsApp. */
@Injectable()
export class MessengerAdapter extends MetaMessagingAdapter {
  readonly channel: ChannelType = 'messenger';

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
          sender?: { id?: string };
          recipient?: { id?: string };
          timestamp?: number;
          message?: {
            mid?: string;
            text?: string;
            is_echo?: boolean;
            attachments?: { type?: string; payload?: { url?: string } }[];
          };
        }[];
      }[];
    };

    const entries: MetaEntry[] = [];
    for (const entry of body.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        const message = event.message;
        // Echoes are the page's own outbound messages coming back; ingesting
        // them would have the agent replying to themselves.
        if (!message?.mid || !event.sender?.id || message.is_echo) continue;

        entries.push({
          messageId: message.mid,
          senderId: event.sender.id,
          recipientId: event.recipient?.id ?? '',
          timestamp: event.timestamp ? Math.floor(event.timestamp / 1000) : undefined,
          text: message.text,
          attachments: (message.attachments ?? []).map((attachment) => ({
            type: attachment.type ?? 'file',
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
      messaging_type: 'RESPONSE',
      message: { text: message.body.slice(0, 2000) },
    };
  }
}
