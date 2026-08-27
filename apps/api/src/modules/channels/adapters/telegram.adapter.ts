import { Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { ChannelType } from '@prisma/client';
import { AppLogger } from '../../../core/logger/logger.service';
import type {
  ChannelAccountContext,
  ChannelAdapter,
  ChannelMetadata,
  DeliveryReceipt,
  MediaObject,
  NormalizedInboundMessage,
  OutboundMessage,
} from '../channel-adapter';

/**
 * Telegram Bot API.
 *
 * Telegram has no signature: the webhook is authenticated by a secret token
 * the bot owner sets when registering the URL, echoed back in a header. It is
 * weaker than an HMAC over the body — it proves the caller knows a secret, not
 * that the body is untampered — so it is compared in constant time and the
 * URL is expected to carry an unguessable component as well.
 */
const API_BASE = 'https://api.telegram.org';

@Injectable()
export class TelegramAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'telegram';

  constructor(private readonly logger: AppLogger) {}

  async receive(payload: unknown): Promise<NormalizedInboundMessage | null> {
    const update = (payload ?? {}) as {
      update_id?: number;
      message?: {
        message_id?: number;
        date?: number;
        text?: string;
        caption?: string;
        chat?: { id?: number };
        from?: { id?: number; first_name?: string; last_name?: string; username?: string };
        photo?: { file_id?: string }[];
        document?: { file_id?: string; file_name?: string; mime_type?: string };
        voice?: { file_id?: string };
      };
    };

    const message = update.message;
    if (!message?.message_id || !message.chat?.id) return null;

    const from = message.from;
    const displayName =
      [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username;

    // Telegram sends several sizes of the same photo; the last is the largest.
    const photo = message.photo?.[message.photo.length - 1];
    const attachments = [
      photo?.file_id
        ? { filename: 'photo.jpg', contentType: 'image/jpeg', reference: photo.file_id }
        : null,
      message.document?.file_id
        ? {
            filename: message.document.file_name ?? 'document',
            contentType: message.document.mime_type ?? 'application/octet-stream',
            reference: message.document.file_id,
          }
        : null,
      message.voice?.file_id
        ? { filename: 'voice.ogg', contentType: 'audio/ogg', reference: message.voice.file_id }
        : null,
    ].filter((attachment): attachment is NonNullable<typeof attachment> => Boolean(attachment));

    return {
      // Chat id plus message id: Telegram's message ids are only unique within
      // a chat, so the chat id alone would collide across customers.
      externalId: `${message.chat.id}:${message.message_id}`,
      threadKey: `telegram:${message.chat.id}`,
      contact: { kind: 'telegram', value: String(message.chat.id), displayName },
      body: message.text ?? message.caption ?? (attachments.length ? '(attachment)' : ''),
      attachments,
      metadata: { updateId: update.update_id, username: from?.username },
      receivedAt: message.date ? new Date(message.date * 1000) : new Date(),
    };
  }

  async send(message: OutboundMessage, account: ChannelAccountContext): Promise<DeliveryReceipt> {
    const token = String(account.credentials.botToken ?? '');
    if (!token) return { state: 'failed', error: 'This account has no bot token configured' };

    try {
      const response = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: message.to,
          text: message.body.slice(0, 4096),
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const body = (await response.json()) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number; chat?: { id?: number } };
      };

      // Telegram answers 200 with ok:false, so the status code is not enough.
      if (!body.ok)
        return { state: 'failed', error: body.description ?? `HTTP ${response.status}` };

      return {
        externalId: `${body.result?.chat?.id}:${body.result?.message_id}`,
        state: 'sent',
      };
    } catch (error) {
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  async media(reference: string, account: ChannelAccountContext): Promise<MediaObject | null> {
    const token = String(account.credentials.botToken ?? '');
    if (!token) return null;

    try {
      const lookup = await fetch(
        `${API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(reference)}`,
        {
          signal: AbortSignal.timeout(15_000),
        },
      );
      const body = (await lookup.json()) as { ok?: boolean; result?: { file_path?: string } };
      if (!body.ok || !body.result?.file_path) return null;

      const download = await fetch(`${API_BASE}/file/bot${token}/${body.result.file_path}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!download.ok) return null;

      return {
        filename: body.result.file_path.split('/').pop() ?? reference,
        contentType: download.headers.get('content-type') ?? 'application/octet-stream',
        content: Buffer.from(await download.arrayBuffer()),
      };
    } catch (error) {
      this.logger.error('Could not fetch Telegram media', error, { reference });
      return null;
    }
  }

  verifySignature(
    _payload: unknown,
    headers: Record<string, string | undefined>,
    account: ChannelAccountContext,
  ): boolean {
    const provided = headers['x-telegram-bot-api-secret-token'];
    const expected = String(account.credentials.webhookSecret ?? '');
    if (!provided || !expected) return false;

    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  metadata(): ChannelMetadata {
    return {
      supportsAttachments: true,
      supportsRichText: true,
      supportsTypingIndicator: true,
      supportsReadReceipts: false,
      maxMessageLength: 4096,
    };
  }
}
