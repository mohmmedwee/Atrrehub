import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { PrismaService } from '../../core/prisma/prisma.service';
import type { TelephonyAccount, TelephonyAdapter, TelephonyProviderKey } from './telephony-adapter';

/**
 * Resolves the adapter for a provider and hydrates its account, decrypting
 * credentials only at the moment of use — the same shape as the messaging
 * `ChannelRegistry`, for the same reason.
 */
@Injectable()
export class TelephonyRegistry {
  private readonly adapters = new Map<TelephonyProviderKey, TelephonyAdapter>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  register(adapter: TelephonyAdapter): void {
    this.adapters.set(adapter.key, adapter);
  }

  adapter(provider: TelephonyProviderKey): TelephonyAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter)
      throw new AppError(
        'not_implemented',
        `The ${provider} telephony provider is not enabled in this deployment`,
      );
    return adapter;
  }

  available(): {
    provider: TelephonyProviderKey;
    capabilities: ReturnType<TelephonyAdapter['capabilities']>;
  }[] {
    return [...this.adapters.values()].map((adapter) => ({
      provider: adapter.key,
      capabilities: adapter.capabilities(),
    }));
  }

  /**
   * Find the account a webhook belongs to.
   *
   * A webhook arrives with no tenant context — that is the whole problem with
   * inbound telephony — so the tenant is resolved from the number being
   * called, which is the only tenant-owned value in the payload.
   */
  async accountFor(provider: TelephonyProviderKey, payload: unknown): Promise<TelephonyAccount> {
    const body = (payload ?? {}) as Record<string, unknown>;
    const to = String(body.To ?? body.to ?? body.destination_number ?? '');

    const number = to
      ? await this.prisma.raw.phoneNumber.findFirst({
          where: { number: to, provider, isActive: true },
        })
      : null;

    if (!number)
      throw AppError.notFound('A phone number matching this call', to || '(none supplied)');

    return this.hydrate(provider, number.organizationId, number.channelAccountId);
  }

  /** The account for the organization already in scope. */
  async accountForOrganization(provider: TelephonyProviderKey): Promise<TelephonyAccount> {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId)
      throw AppError.badRequest('A telephony account can only be resolved inside an organization');
    return this.hydrate(provider, organizationId);
  }

  private async hydrate(
    provider: TelephonyProviderKey,
    organizationId: string,
    channelAccountId?: string | null,
  ): Promise<TelephonyAccount> {
    const account = channelAccountId
      ? await this.prisma.raw.channelAccount.findFirst({ where: { id: channelAccountId } })
      : await this.prisma.raw.channelAccount.findFirst({
          where: { organizationId, channel: 'voice', isActive: true },
        });

    // A deployment can run the simulated provider with no account configured
    // at all, which is what makes the demo and the tests work out of the box.
    if (!account) return { id: `${provider}-default`, organizationId, credentials: {}, config: {} };

    const credentials = this.crypto.decryptObject(
      (account.credentials ?? {}) as Record<string, unknown>,
    );

    return {
      id: account.id,
      organizationId: account.organizationId,
      credentials: Object.fromEntries(
        Object.entries(credentials).map(([key, value]) => [key, String(value ?? '')]),
      ),
      config: (account.config ?? {}) as Record<string, unknown>,
    };
  }
}
