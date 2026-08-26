import { Injectable } from '@nestjs/common';
import type { ChannelType } from '@prisma/client';
import { MailService } from '../../../core/mail/mail.service';
import { AppLogger } from '../../../core/logger/logger.service';
import type {
  ChannelAccountContext,
  ChannelAdapter,
  ChannelMetadata,
  DeliveryReceipt,
  NormalizedInboundMessage,
  OutboundMessage,
} from '../channel-adapter';

export interface InboundEmailPayload {
  messageId: string;
  from: string;
  fromName?: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: { filename: string; contentType: string; content: string }[];
  receivedAt?: string;
}

/**
 * Email channel.
 *
 * Threading follows RFC 5322: `In-Reply-To`/`References` identify the original
 * thread when present, and the platform stamps outbound mail with a reference
 * token in the subject so replies from clients that drop those headers still
 * land on the right conversation.
 */
@Injectable()
export class EmailAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'email';

  constructor(
    private readonly mail: MailService,
    private readonly logger: AppLogger,
  ) {}

  /** `[#C-9F2K4Q]` — recoverable from a subject line even after several replies. */
  static referenceToken(reference: string): string {
    return `[#${reference}]`;
  }

  static extractReference(subject: string | undefined): string | null {
    const match = /\[#([A-Z]-[A-Z0-9]{4,10})\]/.exec(subject ?? '');
    return match ? match[1] : null;
  }

  /** Strip quoted history so an AI or agent reads only what was actually written. */
  static stripQuotedReply(text: string): string {
    const markers = [
      /^-{2,}\s*Original Message\s*-{2,}$/im,
      /^On .+ wrote:$/im,
      /^_{10,}$/m,
      /^From:\s.+$/im,
      /^-{2,}\s*Forwarded message\s*-{2,}$/im,
    ];
    let cut = text.length;
    for (const marker of markers) {
      const match = marker.exec(text);
      if (match?.index !== undefined && match.index < cut) cut = match.index;
    }
    const stripped = text.slice(0, cut);
    // Also drop a trailing run of quoted lines.
    return stripped
      .split('\n')
      .reduce<string[]>((lines, line) => {
        lines.push(line);
        return lines;
      }, [])
      .join('\n')
      .replace(/(\n>.*)+$/g, '')
      .trim();
  }

  async receive(
    payload: unknown,
    _account: ChannelAccountContext,
  ): Promise<NormalizedInboundMessage | null> {
    const email = payload as InboundEmailPayload;
    if (!email?.from) return null;

    const text = email.text ?? stripHtml(email.html ?? '');
    const body = EmailAdapter.stripQuotedReply(text) || '(no content)';

    // Prefer explicit threading headers; fall back to the subject token.
    const threadKey =
      email.references?.[0] ??
      email.inReplyTo ??
      (EmailAdapter.extractReference(email.subject)
        ? `ref:${EmailAdapter.extractReference(email.subject)}`
        : undefined) ??
      `email:${email.messageId}`;

    return {
      externalId: email.messageId,
      threadKey,
      contact: { kind: 'email', value: email.from, displayName: email.fromName },
      subject: email.subject?.replace(/\[#[A-Z]-[A-Z0-9]{4,10}\]\s*/g, '').trim(),
      body,
      bodyHtml: email.html,
      attachments: email.attachments?.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: Buffer.from(attachment.content, 'base64'),
      })),
      metadata: { inReplyTo: email.inReplyTo, references: email.references },
      receivedAt: email.receivedAt ? new Date(email.receivedAt) : new Date(),
    };
  }

  async send(message: OutboundMessage, account: ChannelAccountContext): Promise<DeliveryReceipt> {
    try {
      const signature = (account.config.signature as string | undefined) ?? '';
      const result = await this.mail.send({
        to: message.to,
        from: (account.config.fromAddress as string | undefined) ?? undefined,
        replyTo: (account.config.replyTo as string | undefined) ?? undefined,
        subject: message.subject ?? 'Re: your enquiry',
        text: signature ? `${message.body}\n\n--\n${signature}` : message.body,
        html: message.bodyHtml
          ? this.mail.renderLayout({
              title: message.subject ?? '',
              body: `${message.bodyHtml}${signature ? `<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"><p style="color:#64748b;font-size:13px">${signature}</p>` : ''}`,
            })
          : undefined,
        inReplyTo: message.inReplyTo,
        references: message.threadKey ? [message.threadKey] : undefined,
        attachments: message.attachments,
      });
      return { externalId: result.messageId, state: 'sent' };
    } catch (error) {
      this.logger.error('Email delivery failed', error, { conversationId: message.conversationId });
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  metadata(): ChannelMetadata {
    return {
      supportsAttachments: true,
      supportsRichText: true,
      supportsTypingIndicator: false,
      supportsReadReceipts: false,
    };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
