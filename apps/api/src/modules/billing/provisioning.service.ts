import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlanTier } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { PLANS } from './plans';

/**
 * Automated tenant provisioning.
 *
 * Signing up through the product creates one tenant at a time, interactively.
 * A reseller onboarding fifty customers, or a control plane standing up a
 * tenant on a data plane, needs to do it from a script — and until now the
 * only options were the public signup form or hand-written SQL.
 *
 * Authenticated by a provisioning key held outside any tenant, because this
 * endpoint creates tenants and therefore cannot belong to one.
 */

export interface ProvisionTenantInput {
  organizationName: string;
  ownerEmail: string;
  ownerFirstName: string;
  ownerLastName: string;
  plan?: PlanTier;
  slug?: string;
  timezone?: string;
  locale?: string;
  seats?: number;
}

@Injectable()
export class ProvisioningService {
  constructor(
    private readonly config: ConfigService<AppConfig>,
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Constant-time comparison of the provisioning key.
   *
   * Absent configuration disables the endpoint entirely rather than defaulting
   * to something: an unconfigured tenant-creation API that accepts a blank key
   * is an open door onto the whole platform.
   */
  authorize(presented: string | undefined): void {
    const expected = process.env.PROVISIONING_KEY ?? '';
    if (!expected)
      throw new AppError(
        'not_implemented',
        'Automated provisioning is disabled; set PROVISIONING_KEY to enable it',
      );
    if (!presented) throw AppError.unauthenticated('A provisioning key is required');

    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw AppError.unauthenticated('That provisioning key is not valid');
  }

  /**
   * Create a tenant, its owner and its subscription in one transaction.
   *
   * All or nothing on purpose: a half-provisioned tenant — an organization
   * with no owner, or an owner who cannot sign in — is worse than a failed
   * call, because nobody notices until the customer does.
   */
  async provision(input: ProvisionTenantInput) {
    const email = input.ownerEmail.trim().toLowerCase();
    const plan = input.plan ?? 'starter';

    const existing = await this.prisma.raw.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing)
      throw AppError.conflict(
        `${email} already has an account; invite them to the new organization instead`,
      );

    // A one-time password nobody keeps: the owner is sent through the reset
    // flow, so the provisioning caller never holds a working credential.
    const temporaryPassword = `Tmp-${this.crypto.randomToken(16)}`;
    const userId = newId('user');

    const result = await this.prisma.raw.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          email,
          firstName: input.ownerFirstName,
          lastName: input.ownerLastName,
          passwordHash: await this.crypto.hashPassword(temporaryPassword),
          status: 'active',
          emailVerifiedAt: new Date(),
        },
      });

      const provisioned = await this.tenancy.provisionOrganization(tx, {
        name: input.organizationName,
        ownerId: userId,
        slug: input.slug,
        timezone: input.timezone,
        locale: input.locale,
      });

      const organization = provisioned.organization;
      await tx.organization.update({ where: { id: organization.id }, data: { plan } });

      const periodEnd = new Date();
      periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
      await tx.subscription.create({
        data: {
          id: newId('subscription'),
          organizationId: organization.id,
          plan,
          seats: input.seats ?? PLANS[plan].limits.seats ?? 5,
          status: 'active',
          currentPeriodEnd: periodEnd,
        },
      });

      return organization;
    });

    await RequestContextStore.runAsSystem(
      () =>
        this.audit.record({
          action: 'provisioning.tenant_created',
          resourceType: 'organization',
          resourceId: result.id,
          after: { plan, ownerEmail: email },
        }),
      result.id,
    );

    this.logger.info('Tenant provisioned', { organizationId: result.id, plan });

    return {
      organization: { id: result.id, name: result.name, slug: result.slug, plan },
      owner: { id: userId, email },
      // The caller is told how to get the owner in, not given a way in itself.
      nextStep: 'Send the owner through the password reset flow to set their credentials',
    };
  }

  /** Suspend a tenant without deleting anything. */
  async setStatus(organizationId: string, status: 'active' | 'suspended') {
    const organization = await this.prisma.raw.organization.findFirst({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw AppError.notFound('Organization', organizationId);

    const subscription = await this.prisma.raw.subscription.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
    if (subscription)
      await this.prisma.raw.subscription.update({
        where: { id: subscription.id },
        data: { status },
      });

    // Suspension revokes sessions rather than only flagging the row, so it
    // takes effect on the next request instead of the next login.
    if (status === 'suspended') {
      const members = await this.prisma.raw.membership.findMany({
        where: { organizationId },
        select: { userId: true },
      });
      await this.prisma.raw.session.deleteMany({
        where: { userId: { in: members.map((member) => member.userId) } },
      });
    }

    await RequestContextStore.runAsSystem(
      () =>
        this.audit.record({
          action:
            status === 'suspended'
              ? 'provisioning.tenant_suspended'
              : 'provisioning.tenant_resumed',
          resourceType: 'organization',
          resourceId: organizationId,
        }),
      organizationId,
    );

    return { organizationId, status };
  }

  /** Tenants and their plans, for a reseller's own console. */
  async list(limit = 100) {
    const organizations = await this.prisma.raw.organization.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        createdAt: true,
        _count: { select: { memberships: true } },
      },
    });

    const subscriptions = await this.prisma.raw.subscription.findMany({
      where: { organizationId: { in: organizations.map((organization) => organization.id) } },
      select: { organizationId: true, status: true, currentPeriodEnd: true },
    });
    const byOrganization = new Map(
      subscriptions.map((subscription) => [subscription.organizationId, subscription]),
    );

    return organizations.map((organization) => ({
      ...organization,
      users: organization._count.memberships,
      status: byOrganization.get(organization.id)?.status ?? 'active',
      currentPeriodEnd: byOrganization.get(organization.id)?.currentPeriodEnd ?? null,
    }));
  }
}
