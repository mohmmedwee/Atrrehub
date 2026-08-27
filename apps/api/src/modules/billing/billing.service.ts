import { Injectable } from '@nestjs/common';
import { Prisma, type PlanTier } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LIMIT_LABELS, PLANS, effectiveLimit, hasFeature, type LimitKey } from './plans';

/**
 * Subscriptions, plan limits and metered usage.
 *
 * Three tables existed for this and none of them had a line of code behind
 * them: `subscriptions`, `usage_records` and `metrics_daily`. A plan column
 * nothing reads is not a plan — every tenant was effectively on enterprise.
 */

/** How each limit is counted. Counting is the whole design. */
type Counter = (
  prisma: PrismaService,
  organizationId: string,
  periodStart: Date,
) => Promise<number>;

const COUNTERS: Record<LimitKey, Counter> = {
  seats: (prisma, organizationId) => prisma.raw.membership.count({ where: { organizationId } }),

  // Monthly limits count the current billing period, not all time — the
  // difference between a usage allowance and a hard cap on the product.
  monthlyConversations: (prisma, organizationId, periodStart) =>
    prisma.raw.conversation.count({
      where: { organizationId, createdAt: { gte: periodStart } },
    }),

  knowledgeBases: (prisma, organizationId) =>
    prisma.raw.knowledgeBase.count({ where: { organizationId } }),

  aiAgents: (prisma, organizationId) => prisma.raw.agent.count({ where: { organizationId } }),

  workflows: (prisma, organizationId) => prisma.raw.workflow.count({ where: { organizationId } }),

  storageGb: async (prisma, organizationId) => {
    const result = await prisma.raw.attachment.aggregate({
      where: { organizationId },
      _sum: { sizeBytes: true },
    });
    return Math.ceil(Number(result._sum.sizeBytes ?? 0) / 1024 ** 3);
  },

  monthlyAiTokens: async (prisma, organizationId, periodStart) => {
    const result = await prisma.raw.aiUsage.aggregate({
      where: { organizationId, createdAt: { gte: periodStart } },
      _sum: { promptTokens: true, completionTokens: true },
    });
    return Number(result._sum.promptTokens ?? 0) + Number(result._sum.completionTokens ?? 0);
  },

  phoneNumbers: (prisma, organizationId) =>
    prisma.raw.phoneNumber.count({ where: { organizationId } }),

  integrations: (prisma, organizationId) =>
    prisma.raw.integration.count({ where: { organizationId } }),

  dataPlanes: async () => 0,
};

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  catalogue() {
    return Object.values(PLANS).map((plan) => ({
      ...plan,
      limits: Object.fromEntries(
        Object.entries(plan.limits).map(([key, value]) => [
          key,
          { value, label: LIMIT_LABELS[key as LimitKey] },
        ]),
      ),
    }));
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  /**
   * The tenant's subscription, created on first read.
   *
   * Every organization predating this module has a `plan` on its row and no
   * subscription, so the first read materializes one from it rather than
   * failing or silently treating them as unlimited.
   */
  async subscription(organizationId?: string) {
    const id = organizationId ?? RequestContextStore.organizationId()!;

    const existing = await this.prisma.raw.subscription.findFirst({
      where: { organizationId: id },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;

    const organization = await this.prisma.raw.organization.findFirst({
      where: { id },
      select: { plan: true },
    });
    if (!organization) throw AppError.notFound('Organization', id);

    return this.prisma.raw.subscription.create({
      data: {
        id: newId('subscription'),
        organizationId: id,
        plan: organization.plan,
        seats: PLANS[organization.plan].limits.seats ?? 5,
        status: 'active',
        currentPeriodEnd: this.nextPeriodEnd(),
      },
    });
  }

  async changePlan(tier: PlanTier, options: { seats?: number; reason?: string } = {}) {
    const organizationId = RequestContextStore.organizationId()!;
    const current = await this.subscription(organizationId);

    // Downgrading below what the tenant already uses would leave them over
    // every limit at once with no way back, so it is refused with the specific
    // numbers rather than accepted and enforced later.
    const breaches = await this.breachesUnder(tier, organizationId);
    if (breaches.length && this.rank(tier) < this.rank(current.plan))
      throw AppError.conflict(
        `That plan is smaller than current usage: ${breaches
          .map((breach) => `${breach.used} ${LIMIT_LABELS[breach.key]} (limit ${breach.limit})`)
          .join('; ')}`,
      );

    const updated = await this.prisma.raw.subscription.update({
      where: { id: current.id },
      data: { plan: tier, seats: options.seats ?? PLANS[tier].limits.seats ?? current.seats },
    });
    await this.prisma.raw.organization.update({
      where: { id: organizationId },
      data: { plan: tier },
    });

    await this.audit.record({
      action: 'billing.plan_changed',
      resourceType: 'subscription',
      resourceId: current.id,
      before: { plan: current.plan },
      after: { plan: tier, reason: options.reason },
    });
    return updated;
  }

  /** Negotiated exceptions. Recorded on the subscription, never on the plan. */
  async setLimitOverrides(overrides: Partial<Record<LimitKey, number | null>>, reason: string) {
    const current = await this.subscription();
    const merged = { ...((current.limits ?? {}) as Record<string, unknown>), ...overrides };

    const updated = await this.prisma.raw.subscription.update({
      where: { id: current.id },
      data: { limits: merged as Prisma.InputJsonValue },
    });
    await this.audit.record({
      action: 'billing.limits_overridden',
      resourceType: 'subscription',
      resourceId: current.id,
      after: { overrides, reason },
    });
    return updated;
  }

  // ── Enforcement ────────────────────────────────────────────────────────────

  /**
   * Refuse the action that would cross a limit.
   *
   * Called *before* the thing is created, with the count it would become —
   * checking afterwards means the tenant is already over and the only options
   * are to delete their work or let it stand.
   */
  async assertWithinLimit(key: LimitKey, adding = 1): Promise<void> {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return;

    const subscription = await this.subscription(organizationId);
    const limit = effectiveLimit(
      subscription.plan,
      key,
      subscription.limits as Record<string, unknown>,
    );
    if (limit === null) return;

    const used = await COUNTERS[key](this.prisma, organizationId, this.periodStart(subscription));
    if (used + adding > limit) throw AppError.quotaExceeded(LIMIT_LABELS[key], limit);
  }

  async assertFeature(feature: string): Promise<void> {
    const subscription = await this.subscription();
    if (!hasFeature(subscription.plan, feature))
      throw AppError.policyBlocked(
        'plan',
        `${feature.replace(/_/g, ' ')} is not included in the ${PLANS[subscription.plan].name} plan`,
      );
  }

  /** Everything a billing screen needs, in one call. */
  async usage() {
    const organizationId = RequestContextStore.organizationId()!;
    const subscription = await this.subscription(organizationId);
    const periodStart = this.periodStart(subscription);
    const overrides = subscription.limits as Record<string, unknown>;

    const entries = await Promise.all(
      (Object.keys(COUNTERS) as LimitKey[]).map(async (key) => {
        const limit = effectiveLimit(subscription.plan, key, overrides);
        const used = await COUNTERS[key](this.prisma, organizationId, periodStart);
        return {
          key,
          label: LIMIT_LABELS[key],
          used,
          limit,
          // A tenant at 90% wants to know before they are at 100%.
          percentUsed: limit === null ? null : Math.round((used / limit) * 100),
          exceeded: limit !== null && used > limit,
        };
      }),
    );

    return {
      plan: subscription.plan,
      planName: PLANS[subscription.plan].name,
      status: subscription.status,
      periodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      limits: entries,
      atRisk: entries.filter((entry) => entry.percentUsed !== null && entry.percentUsed >= 80),
    };
  }

  // ── Metered usage ──────────────────────────────────────────────────────────

  /**
   * Write this period's counters into `usage_records`.
   *
   * The live counts are computed from operational tables, which is correct for
   * enforcement and useless for invoicing: a bill has to be reproducible after
   * the conversations it counted have been deleted under retention. This is
   * that record.
   */
  async rollupUsage(organizationId: string, at = new Date()): Promise<number> {
    const subscription = await this.subscription(organizationId);
    const periodStart = this.periodStart(subscription, at);
    const periodEnd = subscription.currentPeriodEnd;

    let written = 0;
    for (const key of Object.keys(COUNTERS) as LimitKey[]) {
      const quantity = await COUNTERS[key](this.prisma, organizationId, periodStart);

      await this.prisma.raw.usageRecord.upsert({
        where: {
          organizationId_metric_periodStart: { organizationId, metric: key, periodStart },
        },
        create: {
          id: newId('usageRecord'),
          organizationId,
          metric: key,
          quantity: new Prisma.Decimal(quantity),
          unit: key.startsWith('monthly') ? 'count/month' : 'count',
          periodStart,
          periodEnd,
        },
        update: { quantity: new Prisma.Decimal(quantity), periodEnd },
      });
      written += 1;
    }

    return written;
  }

  async rollupAllTenants(): Promise<number> {
    const organizations = await this.prisma.raw.organization.findMany({ select: { id: true } });

    let done = 0;
    for (const organization of organizations) {
      try {
        await RequestContextStore.runAsSystem(
          () => this.rollupUsage(organization.id),
          organization.id,
        );
        done += 1;
      } catch (error) {
        this.logger.error('Usage rollup failed', error, { organizationId: organization.id });
      }
    }
    return done;
  }

  async usageHistory(months = 6) {
    const organizationId = RequestContextStore.organizationId()!;
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - months);

    const records = await this.prisma.raw.usageRecord.findMany({
      where: { organizationId, periodStart: { gte: since } },
      orderBy: [{ periodStart: 'desc' }, { metric: 'asc' }],
    });
    return records.map((record) => ({ ...record, quantity: Number(record.quantity) }));
  }

  /**
   * What this period would cost at list price.
   *
   * Deliberately an estimate and labelled as one: it does not know about the
   * discounts, commitments and currency terms a real contract carries, and a
   * number that pretends otherwise would be quoted back at somebody.
   */
  async estimateInvoice() {
    const subscription = await this.subscription();
    const plan = PLANS[subscription.plan];
    const seats = await COUNTERS.seats(this.prisma, subscription.organizationId, new Date(0));

    const includedSeats = plan.limits.seats ?? seats;
    const extraSeats = Math.max(0, seats - includedSeats);

    return {
      plan: plan.name,
      basis: 'list price, before any negotiated terms',
      monthlyPriceUsd: plan.monthlyPriceUsd,
      seats,
      includedSeats,
      extraSeats,
      extraSeatUsd: extraSeats * plan.perSeatUsd,
      estimatedTotalUsd: plan.monthlyPriceUsd + extraSeats * plan.perSeatUsd,
      periodEnd: subscription.currentPeriodEnd,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async breachesUnder(tier: PlanTier, organizationId: string) {
    const breaches: { key: LimitKey; used: number; limit: number }[] = [];
    const periodStart = this.periodStart(await this.subscription(organizationId));

    for (const key of Object.keys(COUNTERS) as LimitKey[]) {
      const limit = PLANS[tier].limits[key];
      if (limit === null) continue;
      const used = await COUNTERS[key](this.prisma, organizationId, periodStart);
      if (used > limit) breaches.push({ key, used, limit });
    }
    return breaches;
  }

  private rank(tier: PlanTier): number {
    return ['starter', 'professional', 'business', 'enterprise'].indexOf(tier);
  }

  /** The billing period runs backwards from the renewal date. */
  private periodStart(subscription: { currentPeriodEnd: Date }, at = new Date()): Date {
    const start = new Date(subscription.currentPeriodEnd);
    start.setUTCMonth(start.getUTCMonth() - 1);
    // A renewal that has already passed means the period rolled over; count
    // from the month containing `at` rather than a window in the past.
    if (start > at) return start;
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  }

  private nextPeriodEnd(): Date {
    const end = new Date();
    end.setUTCMonth(end.getUTCMonth() + 1);
    return end;
  }
}
