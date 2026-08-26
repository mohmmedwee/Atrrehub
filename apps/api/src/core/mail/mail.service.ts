import { Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { AppLogger } from '../logger/logger.service';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface OutboundMail {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  headers?: Record<string, string>;
  attachments?: MailAttachment[];
  /** Set on replies so downstream clients thread correctly. */
  inReplyTo?: string;
  references?: string[];
}

export interface MailConfig {
  driver: 'smtp' | 'log';
  from: string;
  smtp: { host?: string; port: number; secure: boolean; user?: string; password?: string };
}

/**
 * Outbound email. The `log` driver keeps development and CI free of an SMTP
 * dependency while still exercising the full rendering path.
 */
@Injectable()
export class MailService {
  private transporter?: Transporter;

  constructor(
    private readonly config: MailConfig,
    private readonly logger: AppLogger,
  ) {}

  private transport(): Transporter | undefined {
    if (this.config.driver !== 'smtp' || !this.config.smtp.host) return undefined;
    this.transporter ??= createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: this.config.smtp.user
        ? { user: this.config.smtp.user, pass: this.config.smtp.password }
        : undefined,
    });
    return this.transporter;
  }

  async send(mail: OutboundMail): Promise<{ messageId: string; accepted: string[] }> {
    const transport = this.transport();
    const from = mail.from ?? this.config.from;

    if (!transport) {
      const messageId = `<log-${Date.now().toString(36)}@atrrehub.local>`;
      this.logger.info('Email dispatched (log driver)', {
        to: mail.to,
        subject: mail.subject,
        messageId,
        bodyPreview: (mail.text ?? mail.html ?? '').slice(0, 200),
      });
      return { messageId, accepted: Array.isArray(mail.to) ? mail.to : [mail.to] };
    }

    const result = await transport.sendMail({
      from,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.bcc,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: mail.headers,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      attachments: mail.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });

    return { messageId: result.messageId, accepted: (result.accepted ?? []).map(String) };
  }

  /** Shared chrome so every transactional email looks like one product. */
  renderLayout(options: { title: string; body: string; ctaLabel?: string; ctaUrl?: string; brandColor?: string }): string {
    const accent = options.brandColor ?? '#2563eb';
    const cta =
      options.ctaLabel && options.ctaUrl
        ? `<p style="margin:32px 0"><a href="${options.ctaUrl}" style="background:${accent};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${options.ctaLabel}</a></p>`
        : '';
    return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:14px;padding:32px">
<tr><td><h1 style="margin:0 0 16px;font-size:20px;line-height:1.35">${options.title}</h1>
<div style="font-size:15px;line-height:1.6;color:#334155">${options.body}</div>${cta}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0 16px">
<p style="margin:0;font-size:12px;color:#94a3b8">Sent by Atrrehub. If you did not expect this email you can safely ignore it.</p>
</td></tr></table></td></tr></table></body></html>`;
  }
}
