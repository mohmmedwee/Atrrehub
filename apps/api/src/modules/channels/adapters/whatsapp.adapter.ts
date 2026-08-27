import { Injectable } from '@nestjs/common';
import type { ChannelType } from '@prisma/client';
import { AppLogger } from '../../../core/logger/logger.service';
import type {
  ChannelAccountContext,
  ChannelMetadata,
  DeliveryReceipt,
  NormalizedInboundMessage,
  OutboundMessage,
} from '../channel-adapter';
import { MetaMessagingAdapter, type MetaEntry } from './meta-base.adapter';

/**
 * WhatsApp Business Cloud API.
 *
 * The rule that makes WhatsApp unlike every other channel: outside a 24-hour
 * window from the customer's last message, free-form text is rejected by Meta
 * and only a pre-approved template may be sent. Discovering that at send time
 * means an agent's reply vanishes silently, so the window is tracked on the
 * account and a late reply is turned into a template rather than failed.
 */
const SESSION_WINDOW_HOURS = 24;

@Injectable()
export class WhatsAppAdapter extends MetaMessagingAdapter {
  readonly channel: ChannelType = 'whatsapp';

  constructor(logger: AppLogger) {
    super(logger);
  }

  protected contactKind(): NormalizedInboundMessage['contact']['kind'] {
    return 'whatsapp';
  }

  protected extractEntries(payload: unknown): MetaEntry[] {
    const body = (payload ?? {}) as {
      entry?: {
        changes?: {
          value?: {
            metadata?: { phone_number_id?: string };
            contacts?: { wa_id?: string; profile?: { name?: string } }[];
            messages?: {
              id?: string;
              from?: string;
              timestamp?: string;
              type?: string;
              text?: { body?: string };
              image?: { id?: string };
              video?: { id?: string };
              audio?: { id?: string };
              document?: { id?: string };
            }[];
          };
        }[];
      }[];
    };

    const entries: MetaEntry[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        for (const message of value?.messages ?? []) {
          if (!message.id || !message.from) continue;

          const contact = value?.contacts?.find((candidate) => candidate.wa_id === message.from);
          const media = message.image ?? message.video ?? message.audio ?? message.document;

          entries.push({
            messageId: message.id,
            senderId: message.from,
            recipientId: value?.metadata?.phone_number_id ?? '',
            senderName: contact?.profile?.name,
            timestamp: message.timestamp ? Number(message.timestamp) : undefined,
            text: message.text?.body,
            attachments: media?.id ? [{ type: message.type ?? 'document', id: media.id }] : [],
          });
        }
      }
    }
    return entries;
  }

  protected sendBody(message: OutboundMessage): Record<string, unknown> {
    const template = message.metadata?.template as
      { name: string; language?: string; parameters?: string[] } | undefined;

    if (template) {
      return {
        messaging_product: 'whatsapp',
        to: message.to,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language ?? 'en' },
          ...(template.parameters?.length
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: template.parameters.map((text) => ({ type: 'text', text })),
                  },
                ],
              }
            : {}),
        },
      };
    }

    return {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'text',
      text: { preview_url: false, body: message.body.slice(0, 4096) },
    };
  }

  /**
   * Whether free-form text is still allowed.
   *
   * Exposed rather than buried so the workspace can tell an agent *before*
   * they type that this reply will need a template.
   */
  static isWithinSessionWindow(lastInboundAt: Date | null | undefined, now = new Date()): boolean {
    if (!lastInboundAt) return false;
    return now.getTime() - lastInboundAt.getTime() < SESSION_WINDOW_HOURS * 3_600_000;
  }

  override async send(
    message: OutboundMessage,
    account: ChannelAccountContext,
  ): Promise<DeliveryReceipt> {
    const lastInbound = message.metadata?.lastInboundAt;
    const within = WhatsAppAdapter.isWithinSessionWindow(
      lastInbound ? new Date(String(lastInbound)) : null,
    );

    if (!within && !message.metadata?.template) {
      const fallback = account.config.fallbackTemplate as
        { name: string; language?: string } | undefined;

      if (!fallback)
        return {
          state: 'failed',
          error:
            'Outside the 24-hour window WhatsApp only accepts an approved template, and this account has no fallback template configured',
        };

      // The agent's words become the template's parameter, so the reply still
      // reaches the customer rather than disappearing.
      return super.send(
        {
          ...message,
          metadata: {
            ...message.metadata,
            template: {
              name: fallback.name,
              language: fallback.language,
              parameters: [message.body.slice(0, 900)],
            },
          },
        },
        account,
      );
    }

    return super.send(message, account);
  }

  override metadata(): ChannelMetadata {
    return { ...super.metadata(), sessionWindowHours: SESSION_WINDOW_HOURS };
  }
}
