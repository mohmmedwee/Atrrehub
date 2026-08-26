import { Injectable } from '@nestjs/common';
import type { ChannelType } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { StorageService } from '../../core/storage/storage.service';
import { CustomersService } from '../customers/customers.service';
import { ConversationsService } from '../conversations/conversations.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ChannelRegistry } from './channel-registry.service';
import { EmailAdapter } from './adapters/email.adapter';
import type { NormalizedInboundMessage } from './channel-adapter';

/**
 * The bridge between channel adapters and the interaction engine.
 *
 * Inbound: normalize → resolve customer → find or open a conversation →
 * persist the message → publish, so routing and AI can pick it up.
 * Outbound: persist first, then deliver, so a provider failure is recorded
 * against a real message rather than lost.
 */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelRegistry,
    private readonly conversations: ConversationsService,
    private readonly customers: CustomersService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeGateway,
    private readonly crypto: CryptoService,
    private readonly events: EventBus,
    private readonly logger: AppLogger,
  ) {}

  // ── Inbound ────────────────────────────────────────────────────────────────

  async ingest(channel: ChannelType, payload: unknown, accountId?: string) {
    const account = accountId
      ? await this.registry.accountContext(accountId)
      : await this.registry.defaultAccount(channel);
    if (!account) throw AppError.badRequest(`No active ${channel} account is configured`);

    const adapter = this.registry.adapter(channel);
    const normalized = await adapter.receive(payload, account);
    if (!normalized) {
      this.logger.debug('Inbound payload produced no message', { channel });
      return null;
    }

    return this.acceptInbound(channel, normalized, account.id, account.queueId ?? undefined, account.workspaceId ?? undefined);
  }

  /** Shared by every adapter and by the widget endpoints. */
  async acceptInbound(
    channel: ChannelType,
    normalized: NormalizedInboundMessage,
    channelAccountId?: string,
    queueId?: string,
    workspaceId?: string,
  ) {
    const organizationId = RequestContextStore.organizationId()!;

    // Providers redeliver on timeout; ingesting twice would double-reply.
    const duplicate = await this.prisma.db.message.findFirst({
      where: { externalId: normalized.externalId },
      select: { id: true, conversationId: true },
    });
    if (duplicate) {
      this.logger.debug('Ignoring a redelivered inbound message', { externalId: normalized.externalId });
      return { conversationId: duplicate.conversationId, messageId: duplicate.id, duplicate: true };
    }

    const { customer } = await this.customers.findOrCreateByContact(normalized.contact.kind, normalized.contact.value, {
      displayName: normalized.contact.displayName,
      locale: normalized.locale,
      workspaceId,
    });

    const conversation = await this.resolveConversation(channel, normalized, customer.id, {
      channelAccountId,
      queueId,
      workspaceId,
    });

    const message = await this.conversations.addMessage({
      conversationId: conversation.id,
      externalId: normalized.externalId,
      body: normalized.body,
      bodyHtml: normalized.bodyHtml,
      direction: 'inbound',
      type: normalized.bodyHtml ? 'html' : 'text',
      authorType: 'customer',
      authorId: customer.id,
      authorName: customer.displayName ?? undefined,
      language: normalized.locale,
      metadata: normalized.metadata,
    });

    if (normalized.attachments?.length) {
      await this.storeAttachments(organizationId, message.id, normalized.attachments);
    }

    this.realtime.emitToConversation(organizationId, conversation.id, 'message', {
      messageId: message.id,
      direction: 'inbound',
      body: message.body,
      authorType: 'customer',
      createdAt: message.createdAt,
    });
    if (conversation.queueId) {
      this.realtime.emitToQueue(organizationId, conversation.queueId, 'queue:updated', { conversationId: conversation.id });
    }

    await this.events.publish(DomainEvent.ChannelInboundReceived, { type: 'conversation', id: conversation.id }, {
      channel,
      externalId: normalized.externalId,
      conversationId: conversation.id,
    });

    return { conversationId: conversation.id, messageId: message.id, customerId: customer.id, duplicate: false };
  }

  /**
   * Find the conversation this message belongs to, or open one.
   *
   * Matching prefers the provider thread key, then the platform reference token
   * an email subject may carry, then any open conversation with the same
   * customer on the same channel — in that order, because each is progressively
   * weaker evidence that it really is the same discussion.
   */
  private async resolveConversation(
    channel: ChannelType,
    normalized: NormalizedInboundMessage,
    customerId: string,
    options: { channelAccountId?: string; queueId?: string; workspaceId?: string },
  ) {
    if (normalized.threadKey) {
      const byThread = await this.prisma.db.conversation.findFirst({
        where: { threadKey: normalized.threadKey, status: { in: ConversationsService.openStatuses } },
      });
      if (byThread) return byThread;
    }

    const reference = EmailAdapter.extractReference(normalized.subject);
    if (reference) {
      const byReference = await this.prisma.db.conversation.findFirst({ where: { reference } });
      if (byReference) {
        // Reopen rather than starting a parallel thread on the same subject.
        if (!ConversationsService.openStatuses.includes(byReference.status)) {
          await this.conversations.setStatus(byReference.id, 'active', 'customer_replied');
        }
        return byReference;
      }
    }

    const recent = await this.prisma.db.conversation.findFirst({
      where: { customerId, channel, status: { in: ConversationsService.openStatuses } },
      orderBy: { lastMessageAt: 'desc' },
    });
    if (recent) return recent;

    return this.conversations.create({
      channel,
      customerId,
      subject: normalized.subject,
      locale: normalized.locale,
      threadKey: normalized.threadKey,
      externalId: normalized.externalId,
      channelAccountId: options.channelAccountId,
      queueId: options.queueId,
      workspaceId: options.workspaceId,
      metadata: normalized.metadata,
    });
  }

  private async storeAttachments(
    organizationId: string,
    messageId: string,
    attachments: NonNullable<NormalizedInboundMessage['attachments']>,
  ) {
    for (const attachment of attachments) {
      if (!attachment.content) continue;
      try {
        const key = this.storage.buildKey(organizationId, 'attachments', attachment.filename);
        const stored = await this.storage.put(key, attachment.content, attachment.contentType);
        await this.prisma.raw.attachment.create({
          data: {
            id: newId('attachment'),
            organizationId,
            messageId,
            filename: attachment.filename,
            contentType: attachment.contentType,
            sizeBytes: stored.size,
            storageKey: stored.key,
            checksum: stored.checksum,
          },
        });
      } catch (error) {
        // A rejected attachment must not discard the message it arrived with.
        this.logger.warn('Rejected an inbound attachment', {
          messageId,
          filename: attachment.filename,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  /**
   * Send a reply. The message row is written before delivery is attempted so a
   * provider failure leaves an auditable record with `failed` state rather than
   * disappearing.
   */
  async sendReply(input: {
    conversationId: string;
    body: string;
    bodyHtml?: string;
    authorType: 'user' | 'ai_agent';
    authorId?: string;
    authorName?: string;
    citations?: unknown[];
    attachments?: { filename: string; content: Buffer; contentType: string }[];
  }) {
    const conversation = await this.conversations.get(input.conversationId);
    const organizationId = RequestContextStore.organizationId()!;

    const message = await this.conversations.addMessage({
      conversationId: input.conversationId,
      body: input.body,
      bodyHtml: input.bodyHtml,
      direction: 'outbound',
      type: input.bodyHtml ? 'html' : 'text',
      authorType: input.authorType,
      authorId: input.authorId,
      authorName: input.authorName,
      citations: input.citations,
    });

    // A conversation being replied to is active, and awaiting the customer.
    if (conversation.status === 'assigned' || conversation.status === 'new') {
      await this.conversations.setStatus(input.conversationId, 'active');
    }

    const destination = conversation.customer?.contactMethods?.[0]?.value;
    if (!this.registry.has(conversation.channel) || !destination) {
      // Web chat delivers over the socket; other channels need a destination.
      await this.conversations.updateDeliveryState(message.id, this.registry.has(conversation.channel) ? 'sent' : 'failed',
        this.registry.has(conversation.channel) ? undefined : 'No delivery address for this customer');
    } else {
      const adapter = this.registry.adapter(conversation.channel);
      const account = conversation.channelAccountId
        ? await this.registry.accountContext(conversation.channelAccountId)
        : await this.registry.defaultAccount(conversation.channel, conversation.workspaceId);

      const receipt = await adapter.send(
        {
          conversationId: conversation.id,
          messageId: message.id,
          to: destination,
          subject: conversation.subject
            ? `${conversation.subject} ${EmailAdapter.referenceToken(conversation.reference)}`
            : `Your enquiry ${EmailAdapter.referenceToken(conversation.reference)}`,
          body: input.body,
          bodyHtml: input.bodyHtml,
          threadKey: conversation.threadKey ?? undefined,
          attachments: input.attachments,
        },
        account ?? {
          id: 'inline',
          organizationId,
          workspaceId: conversation.workspaceId,
          queueId: conversation.queueId,
          credentials: {},
          config: {},
        },
      );

      await this.conversations.updateDeliveryState(message.id, receipt.state, receipt.error);
      if (receipt.externalId) {
        await this.prisma.db.message.update({ where: { id: message.id }, data: { externalId: receipt.externalId } });
      }
      await this.events.publish(
        receipt.state === 'failed' ? DomainEvent.ChannelDeliveryFailed : DomainEvent.ChannelOutboundSent,
        { type: 'message', id: message.id },
        { channel: conversation.channel, messageId: message.id, reason: receipt.error },
      );
    }

    this.realtime.emitToConversation(organizationId, conversation.id, 'message', {
      messageId: message.id,
      direction: 'outbound',
      body: message.body,
      authorType: input.authorType,
      createdAt: message.createdAt,
    });

    // Re-read so the caller sees the settled delivery state and any provider id
    // rather than the row as it looked before delivery was attempted.
    return this.prisma.db.message.findFirstOrThrow({ where: { id: message.id } });
  }

  // ── Channel accounts ───────────────────────────────────────────────────────

  async listAccounts() {
    const accounts = await this.prisma.db.channelAccount.findMany({ where: {}, orderBy: { createdAt: 'asc' } });
    // Credentials never leave the server, not even to an administrator.
    return accounts.map(({ credentials: _credentials, ...account }) => ({
      ...account,
      hasCredentials: Object.keys((_credentials ?? {}) as object).length > 0,
    }));
  }

  async createAccount(input: {
    channel: ChannelType;
    name: string;
    credentials?: Record<string, unknown>;
    config?: Record<string, unknown>;
    queueId?: string;
    workspaceId?: string;
  }) {
    if (!this.registry.has(input.channel)) {
      throw new AppError('not_implemented', `The ${input.channel} channel is not enabled in this deployment`);
    }
    const account = await this.prisma.db.channelAccount.create({
      data: {
        id: newId('channelAccount'),
        channel: input.channel,
        name: input.name,
        credentials: this.crypto.encryptObject(input.credentials ?? {}) as never,
        config: (input.config ?? {}) as never,
        queueId: input.queueId ?? null,
        workspaceId: input.workspaceId ?? null,
      } as never,
    });
    const { credentials: _credentials, ...safe } = account;
    return safe;
  }

  async updateAccount(accountId: string, patch: { name?: string; credentials?: Record<string, unknown>; config?: Record<string, unknown>; queueId?: string | null; isActive?: boolean }) {
    const account = await this.prisma.db.channelAccount.update({
      where: { id: accountId },
      data: {
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.credentials ? { credentials: this.crypto.encryptObject(patch.credentials) as never } : {}),
        ...(patch.config ? { config: patch.config as never } : {}),
        ...(patch.queueId !== undefined ? { queueId: patch.queueId } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
    });
    const { credentials: _credentials, ...safe } = account;
    return safe;
  }

  async deleteAccount(accountId: string) {
    await this.prisma.db.channelAccount.delete({ where: { id: accountId } });
  }

  available() {
    return this.registry.available();
  }
}
