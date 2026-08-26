import { Injectable } from '@nestjs/common';
import type { ChannelType } from '@prisma/client';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { PrismaService } from '../../core/prisma/prisma.service';
import type { ChannelAccountContext, ChannelAdapter } from './channel-adapter';

/**
 * Resolves the adapter for a channel and hydrates the account context,
 * decrypting provider credentials only at the moment of use.
 */
@Injectable()
export class ChannelRegistry {
  private readonly adapters = new Map<ChannelType, ChannelAdapter>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  adapter(channel: ChannelType): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      throw new AppError('not_implemented', `The ${channel} channel is not enabled in this deployment`);
    }
    return adapter;
  }

  has(channel: ChannelType): boolean {
    return this.adapters.has(channel);
  }

  /** Channels this deployment can actually serve, with their capabilities. */
  available(): { channel: ChannelType; metadata: ReturnType<ChannelAdapter['metadata']> }[] {
    return [...this.adapters.values()].map((adapter) => ({
      channel: adapter.channel,
      metadata: adapter.metadata(),
    }));
  }

  async accountContext(accountId: string): Promise<ChannelAccountContext> {
    const account = await this.prisma.db.channelAccount.findFirst({ where: { id: accountId } });
    if (!account) throw AppError.notFound('Channel account', accountId);
    return this.toContext(account);
  }

  /** The active account for a channel, used when inbound traffic names no account. */
  async defaultAccount(channel: ChannelType, workspaceId?: string | null): Promise<ChannelAccountContext | null> {
    const account = await this.prisma.db.channelAccount.findFirst({
      where: { channel, isActive: true, ...(workspaceId ? { workspaceId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    return account ? this.toContext(account) : null;
  }

  private toContext(account: {
    id: string;
    organizationId: string;
    workspaceId: string | null;
    queueId: string | null;
    credentials: unknown;
    config: unknown;
  }): ChannelAccountContext {
    return {
      id: account.id,
      organizationId: account.organizationId,
      workspaceId: account.workspaceId,
      queueId: account.queueId,
      credentials: this.crypto.decryptObject((account.credentials ?? {}) as Record<string, unknown>),
      config: (account.config ?? {}) as Record<string, unknown>,
    };
  }
}
