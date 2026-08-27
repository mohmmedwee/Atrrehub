import { createHmac, timingSafeEqual } from 'node:crypto';
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
 * Shared behaviour for Meta's messaging platforms.
 *
 * WhatsApp, Messenger and Instagram are three products over one Graph API:
 * the same webhook envelope, the same `X-Hub-Signature-256` scheme, the same
 * subscription challenge, the same media-by-reference model. Writing them as
 * three independent adapters would have meant three copies of the signature
 * check — and a signature check that exists in triplicate is one that gets
 * fixed in one place.
 *
 * What genuinely differs — the entry shape, the send envelope, the session
 * rules — is left abstract.
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface MetaEntry {
  senderId: string;
  recipientId: string;
  messageId: string;
  timestamp?: number;
  text?: string;
  attachments?: { type: string; url?: string; id?: string }[];
  senderName?: string;
}

export abstract class MetaMessagingAdapter implements ChannelAdapter {
  abstract readonly channel: ChannelType;

  constructor(protected readonly logger: AppLogger) {}

  /** Pull the platform-specific entries out of a webhook body. */
  protected abstract extractEntries(payload: unknown): MetaEntry[];

  /** Build the Graph send body for this platform. */
  protected abstract sendBody(message: OutboundMessage): Record<string, unknown>;

  protected abstract contactKind(): NormalizedInboundMessage['contact']['kind'];

  async receive(payload: unknown): Promise<NormalizedInboundMessage | null> {
    const [entry] = this.extractEntries(payload);
    if (!entry) return null;

    return {
      externalId: entry.messageId,
      // One conversation per person per channel: these platforms have no
      // thread concept, so the sender *is* the thread.
      threadKey: `${this.channel}:${entry.senderId}`,
      contact: {
        kind: this.contactKind(),
        value: entry.senderId,
        displayName: entry.senderName,
      },
      body: entry.text ?? '',
      attachments: (entry.attachments ?? []).map((attachment) => ({
        filename: attachment.id ?? 'attachment',
        contentType: this.contentTypeFor(attachment.type),
        reference: attachment.id ?? attachment.url,
      })),
      metadata: { platform: this.channel, recipientId: entry.recipientId },
      receivedAt: entry.timestamp ? new Date(entry.timestamp * 1000) : new Date(),
    };
  }

  async send(message: OutboundMessage, account: ChannelAccountContext): Promise<DeliveryReceipt> {
    const phoneNumberId = String(account.config.phoneNumberId ?? account.config.pageId ?? '');
    const token = String(account.credentials.accessToken ?? '');
    if (!phoneNumberId || !token)
      return { state: 'failed', error: 'This account has no page id or access token configured' };

    try {
      const response = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.sendBody(message)),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { state: 'failed', error: `${response.status}: ${detail.slice(0, 300)}` };
      }

      const body = (await response.json()) as { messages?: { id: string }[]; message_id?: string };
      return { externalId: body.messages?.[0]?.id ?? body.message_id, state: 'sent' };
    } catch (error) {
      return {
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async media(reference: string, account: ChannelAccountContext): Promise<MediaObject | null> {
    const token = String(account.credentials.accessToken ?? '');
    if (!token) return null;

    try {
      // Media arrives as an id; the URL it resolves to is short-lived and
      // still needs the token, so it is fetched immediately and stored.
      const lookup = await fetch(`${GRAPH_BASE}/${reference}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!lookup.ok) return null;

      const { url, mime_type: mimeType } = (await lookup.json()) as {
        url?: string;
        mime_type?: string;
      };
      if (!url) return null;

      const download = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!download.ok) return null;

      return {
        filename: reference,
        contentType: mimeType ?? download.headers.get('content-type') ?? 'application/octet-stream',
        content: Buffer.from(await download.arrayBuffer()),
      };
    } catch (error) {
      this.logger.error('Could not fetch Meta media', error, { reference });
      return null;
    }
  }

  /**
   * `X-Hub-Signature-256`: HMAC-SHA256 of the raw body under the app secret.
   *
   * Compared over the raw bytes, not a re-serialization: JSON round-tripping
   * changes key order and whitespace, and the digest would never match.
   */
  verifySignature(
    _payload: unknown,
    headers: Record<string, string | undefined>,
    account: ChannelAccountContext,
    rawBody?: string,
  ): boolean {
    const header = headers['x-hub-signature-256'];
    const secret = String(account.credentials.appSecret ?? '');
    if (!header?.startsWith('sha256=') || !secret || rawBody === undefined) return false;

    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(header.slice(7), 'hex');
    } catch {
      return false;
    }
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  /** Meta verifies an endpoint by GETting it with a token before subscribing. */
  challenge(
    query: Record<string, string | undefined>,
    account: ChannelAccountContext,
  ): string | null {
    const expected = String(account.credentials.verifyToken ?? '');
    if (!expected) return null;
    if (query['hub.mode'] !== 'subscribe') return null;
    if (query['hub.verify_token'] !== expected) return null;
    return query['hub.challenge'] ?? null;
  }

  metadata(): ChannelMetadata {
    return {
      supportsAttachments: true,
      supportsRichText: false,
      supportsTypingIndicator: true,
      supportsReadReceipts: true,
      maxMessageLength: 4096,
    };
  }

  protected contentTypeFor(type: string): string {
    switch (type) {
      case 'image':
        return 'image/jpeg';
      case 'video':
        return 'video/mp4';
      case 'audio':
      case 'voice':
        return 'audio/mpeg';
      case 'document':
        return 'application/pdf';
      default:
        return 'application/octet-stream';
    }
  }
}
