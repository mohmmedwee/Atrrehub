import { Injectable } from '@nestjs/common';
import type { ChannelType } from '@prisma/client';
import { AppLogger } from '../../../core/logger/logger.service';
import type {
  ChannelAccountContext,
  ChannelAdapter,
  ChannelMetadata,
  DeliveryReceipt,
  NormalizedInboundMessage,
  OutboundMessage,
} from '../channel-adapter';

/**
 * Microsoft Teams, over the Bot Framework.
 *
 * Unlike the other channels, Teams does not sign its payload: it sends a
 * bearer token issued by Microsoft's identity platform, which must be
 * validated against their published JWKS. That validation is deliberately not
 * hand-rolled here — the OIDC verifier built for enterprise SSO already does
 * exactly this, and a second, weaker implementation of JWT verification is how
 * an authentication bypass gets shipped.
 *
 * Until it is wired to that verifier, `verifySignature` returns false unless
 * the deployment sets a shared secret on the account, so an unconfigured Teams
 * channel refuses inbound traffic rather than trusting it.
 */
@Injectable()
export class TeamsAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'teams';

  constructor(private readonly logger: AppLogger) {}

  async receive(payload: unknown): Promise<NormalizedInboundMessage | null> {
    const activity = (payload ?? {}) as {
      id?: string;
      type?: string;
      text?: string;
      timestamp?: string;
      serviceUrl?: string;
      from?: { id?: string; name?: string; aadObjectId?: string };
      conversation?: { id?: string };
      attachments?: { contentType?: string; contentUrl?: string; name?: string }[];
    };

    // Teams sends conversationUpdate, typing and many other activity types
    // down the same webhook; only a message is a message.
    if (activity.type !== 'message' || !activity.id || !activity.from?.id) return null;

    return {
      externalId: activity.id,
      threadKey: `teams:${activity.conversation?.id ?? activity.from.id}`,
      contact: {
        kind: 'external',
        value: activity.from.aadObjectId ?? activity.from.id,
        displayName: activity.from.name,
      },
      body: activity.text ?? '',
      attachments: (activity.attachments ?? [])
        .filter((attachment) => attachment.contentUrl)
        .map((attachment) => ({
          filename: attachment.name ?? 'attachment',
          contentType: attachment.contentType ?? 'application/octet-stream',
          reference: attachment.contentUrl,
        })),
      // The service URL is per-tenant and required to reply, so it is carried
      // forward rather than assumed to be a constant.
      metadata: { serviceUrl: activity.serviceUrl, conversationId: activity.conversation?.id },
      receivedAt: activity.timestamp ? new Date(activity.timestamp) : new Date(),
    };
  }

  async send(message: OutboundMessage, account: ChannelAccountContext): Promise<DeliveryReceipt> {
    const serviceUrl = String(message.metadata?.serviceUrl ?? account.config.serviceUrl ?? '');
    const conversationId = String(message.metadata?.conversationId ?? message.to);
    if (!serviceUrl)
      return { state: 'failed', error: 'No Teams service URL for this conversation' };

    const token = await this.accessToken(account);
    if (!token) return { state: 'failed', error: 'Could not obtain a Bot Framework token' };

    try {
      const response = await fetch(
        `${serviceUrl.replace(/\/+$/, '')}/v3/conversations/${encodeURIComponent(conversationId)}/activities`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'message', text: message.body }),
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { state: 'failed', error: `${response.status}: ${detail.slice(0, 300)}` };
      }

      const body = (await response.json()) as { id?: string };
      return { externalId: body.id, state: 'sent' };
    } catch (error) {
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Client-credentials token for the Bot Framework. */
  private async accessToken(account: ChannelAccountContext): Promise<string | null> {
    const appId = String(account.credentials.appId ?? '');
    const appPassword = String(account.credentials.appPassword ?? '');
    if (!appId || !appPassword) return null;

    try {
      const response = await fetch(
        'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: appId,
            client_secret: appPassword,
            scope: 'https://api.botframework.com/.default',
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) return null;

      const body = (await response.json()) as { access_token?: string };
      return body.access_token ?? null;
    } catch (error) {
      this.logger.error('Could not obtain a Bot Framework token', error);
      return null;
    }
  }

  verifySignature(
    _payload: unknown,
    headers: Record<string, string | undefined>,
    account: ChannelAccountContext,
  ): boolean {
    // A shared secret is a stop-gap, not the Bot Framework's own scheme. When
    // one is not configured this refuses everything, which is the correct
    // posture for a channel whose real verification is not yet wired.
    const expected = String(account.credentials.sharedSecret ?? '');
    if (!expected) return false;

    const provided = headers.authorization?.replace(/^Bearer\s+/i, '');
    return Boolean(provided) && provided === expected;
  }

  metadata(): ChannelMetadata {
    return {
      supportsAttachments: true,
      supportsRichText: true,
      supportsTypingIndicator: true,
      supportsReadReceipts: false,
      maxMessageLength: 28_000,
    };
  }
}
