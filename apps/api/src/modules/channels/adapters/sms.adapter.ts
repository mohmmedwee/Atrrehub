import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelType } from '@prisma/client';
import { AppLogger } from '../../../core/logger/logger.service';
import type {
  ChannelAccountContext,
  ChannelAdapter,
  ChannelMetadata,
  DeliveryReceipt,
  DeliveryState,
  NormalizedInboundMessage,
  OutboundMessage,
} from '../channel-adapter';

/**
 * SMS over Twilio.
 *
 * A single SMS carries 160 GSM-7 characters, or 70 once any character forces
 * UCS-2 — one emoji in a support reply silently more than halves the limit.
 * Twilio will segment a long body itself, but each segment is billed, so the
 * platform reports the count rather than discovering it on an invoice.
 */
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€';

@Injectable()
export class SmsAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'sms';

  constructor(private readonly logger: AppLogger) {}

  /** Whether the whole body survives GSM-7, which decides the segment size. */
  static isGsm7(text: string): boolean {
    return [...text].every((char) => GSM7.includes(char) || GSM7_EXTENDED.includes(char));
  }

  /** How many billable segments a body will become. */
  static segments(text: string): number {
    if (!text.length) return 0;
    const gsm = SmsAdapter.isGsm7(text);
    // Extended characters occupy two septets each.
    const length = gsm
      ? [...text].reduce((sum, char) => sum + (GSM7_EXTENDED.includes(char) ? 2 : 1), 0)
      : [...text].length;

    const single = gsm ? 160 : 70;
    const concatenated = gsm ? 153 : 67;
    return length <= single ? 1 : Math.ceil(length / concatenated);
  }

  async receive(payload: unknown): Promise<NormalizedInboundMessage | null> {
    const body = (payload ?? {}) as Record<string, string>;
    if (!body.MessageSid || !body.From) return null;

    const mediaCount = Number(body.NumMedia ?? 0);
    const attachments = Array.from({ length: mediaCount }, (_, index) => ({
      filename: `media-${index}`,
      contentType: body[`MediaContentType${index}`] ?? 'application/octet-stream',
      reference: body[`MediaUrl${index}`],
    })).filter((attachment) => attachment.reference);

    return {
      externalId: body.MessageSid,
      threadKey: `sms:${body.From}`,
      contact: { kind: 'phone', value: body.From },
      body: body.Body ?? '',
      attachments,
      metadata: { to: body.To, segments: Number(body.NumSegments ?? 1) },
      receivedAt: new Date(),
    };
  }

  async send(message: OutboundMessage, account: ChannelAccountContext): Promise<DeliveryReceipt> {
    const accountSid = String(account.credentials.accountSid ?? '');
    const authToken = String(account.credentials.authToken ?? '');
    const from = String(account.config.fromNumber ?? '');
    if (!accountSid || !authToken || !from)
      return { state: 'failed', error: 'This account has no Twilio credentials or from-number' };

    const segments = SmsAdapter.segments(message.body);
    if (segments > 10)
      return {
        state: 'failed',
        error: `${segments} segments is too long for SMS — send a link instead`,
      };

    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ From: from, To: message.to, Body: message.body }),
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { state: 'failed', error: `${response.status}: ${detail.slice(0, 300)}` };
      }

      const body = (await response.json()) as { sid?: string };
      return { externalId: body.sid, state: 'sent' };
    } catch (error) {
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(externalId: string, account: ChannelAccountContext): Promise<DeliveryState> {
    const accountSid = String(account.credentials.accountSid ?? '');
    const authToken = String(account.credentials.authToken ?? '');
    if (!accountSid || !authToken) return 'pending';

    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages/${externalId}.json`,
        {
          headers: {
            authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) return 'pending';

      const { status } = (await response.json()) as { status?: string };
      switch (status) {
        case 'delivered':
          return 'delivered';
        case 'read':
          return 'read';
        case 'failed':
        case 'undelivered':
          return 'failed';
        case 'sent':
          return 'sent';
        default:
          return 'pending';
      }
    } catch {
      return 'pending';
    }
  }

  /** Twilio signs `url + sorted(params)` with the auth token, using SHA-1. */
  verifySignature(
    payload: unknown,
    headers: Record<string, string | undefined>,
    account: ChannelAccountContext,
  ): boolean {
    const signature = headers['x-twilio-signature'];
    const authToken = String(account.credentials.authToken ?? '');
    const url = String(account.config.webhookUrl ?? '');
    if (!signature || !authToken || !url) return false;

    const params = (payload ?? {}) as Record<string, string>;
    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + String(params[key]), url);

    const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'base64');
    } catch {
      return false;
    }
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  metadata(): ChannelMetadata {
    return {
      supportsAttachments: true,
      supportsRichText: false,
      supportsTypingIndicator: false,
      supportsReadReceipts: true,
      maxMessageLength: 1600,
    };
  }
}
