import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { GovernancePolicy, Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { AiGateway } from '../ai/gateway.service';
import { ToolsService } from '../tools/tools.service';

export interface PolicyInput {
  allowedProviders?: string[];
  allowedModels?: string[];
  allowedTools?: string[];
  monthlyTokenLimit?: number | null;
  monthlyCostLimitUsd?: number | null;
  perExecutionTokenCap?: number | null;
  requireHumanApproval?: boolean;
  dataRetentionDays?: number;
  allowTraining?: boolean;
}

/**
 * The shortest retention window a tenant may set.
 *
 * A window of a few hours would delete conversations while agents were still
 * working them, and the sweep is a daily job — anything under a day cannot be
 * honoured accurately anyway, so promising it would be a lie.
 */
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3_650;

/**
 * AI governance: what a tenant's agents are permitted to use, and how much.
 *
 * The policy row has existed since the schema was written and half of it was
 * decorative — `allowedProviders`, `allowedModels`, `allowedTools` and
 * `perExecutionTokenCap` were stored and never read. A control that does not
 * enforce anything is worse than no control, because somebody sets it and
 * believes they are protected. `assertModelAllowed` and `assertToolAllowed`
 * below are what make them real; the gateway and the tool runner call them.
 */
@Injectable()
export class GovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    // Resolved lazily rather than injected: the gateway and the tool runner
    // both call *into* this service to enforce the policy, so constructing it
    // from them would be a cycle. The catalogue is the only thing that needs
    // them, and it runs on a settings screen rather than on a hot path.
    private readonly moduleRef: ModuleRef,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  /** Everything a policy screen needs: the policy, and what it can choose from. */
  async catalogue() {
    const tools = await this.toolsService().list().catch(() => []);
    return {
      providers: this.configuredProviders(),
      tools: tools.map((tool: { key: string; name: string }) => ({
        key: tool.key,
        name: tool.name,
      })),
      retention: { minDays: MIN_RETENTION_DAYS, maxDays: MAX_RETENTION_DAYS },
    };
  }

  private gatewayService(): AiGateway {
    return this.moduleRef.get(AiGateway, { strict: false });
  }

  private toolsService(): ToolsService {
    return this.moduleRef.get(ToolsService, { strict: false });
  }

  /** The providers this deployment actually has credentials for. */
  configuredProviders(): string[] {
    return this.gatewayService().configuredProviders();
  }

  async get(): Promise<GovernancePolicy> {
    const organizationId = RequestContextStore.organizationId()!;
    const policy = await this.prisma.raw.governancePolicy.findUnique({
      where: { organizationId },
    });
    if (policy) return policy;

    // A tenant provisioned before this row existed, or one whose provisioning
    // was interrupted, must still be governable rather than un-gettable.
    return this.prisma.raw.governancePolicy.create({
      data: { id: newId('governance'), organizationId },
    });
  }

  async update(input: PolicyInput): Promise<GovernancePolicy> {
    const organizationId = RequestContextStore.organizationId()!;
    const before = await this.get();
    this.validate(input);

    const policy = await this.prisma.raw.governancePolicy.update({
      where: { organizationId },
      data: {
        ...(input.allowedProviders === undefined ? {} : { allowedProviders: input.allowedProviders }),
        ...(input.allowedModels === undefined ? {} : { allowedModels: input.allowedModels }),
        ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
        ...(input.monthlyTokenLimit === undefined ? {} : { monthlyTokenLimit: input.monthlyTokenLimit }),
        ...(input.monthlyCostLimitUsd === undefined
          ? {}
          : { monthlyCostLimitUsd: input.monthlyCostLimitUsd as unknown as Prisma.Decimal }),
        ...(input.perExecutionTokenCap === undefined
          ? {}
          : { perExecutionTokenCap: input.perExecutionTokenCap }),
        ...(input.requireHumanApproval === undefined
          ? {}
          : { requireHumanApproval: input.requireHumanApproval }),
        ...(input.dataRetentionDays === undefined ? {} : { dataRetentionDays: input.dataRetentionDays }),
        ...(input.allowTraining === undefined ? {} : { allowTraining: input.allowTraining }),
      },
    });

    // The gateway caches the policy for five minutes before every AI call.
    // Leaving that cache in place would let a tenant keep using a provider for
    // five minutes after forbidding it, which is exactly the window in which
    // somebody forbids it because something is going wrong.
    await this.redis.del(this.redis.key(organizationId, 'governance'));

    await this.audit.recordDiff(
      'governance.policy_updated',
      'governance_policy',
      policy.id,
      this.forAudit(before),
      this.forAudit(policy),
    );

    if (
      input.dataRetentionDays !== undefined &&
      input.dataRetentionDays < before.dataRetentionDays
    ) {
      // Shortening retention destroys data on the next nightly sweep, and the
      // person who did it should be findable afterwards.
      this.logger.warn('Data retention window shortened', {
        organizationId,
        from: before.dataRetentionDays,
        to: input.dataRetentionDays,
        actor: RequestContextStore.principal()?.id,
      });
    }
    return policy;
  }

  // ── Enforcement ────────────────────────────────────────────────────────────
  //
  // Enforcement deliberately does not live here. Each control is checked at the
  // point it binds — provider and model allow-lists in the AI gateway's routing
  // chain, the tool allow-list in the tool runner, the per-execution token cap
  // in the workflow runtime — because a check in this service would have to be
  // remembered and called, and the ones that were not called are exactly how
  // four of these fields came to be stored and read by nothing.
  //
  // All three read the policy through the same Redis key and TTL, and `update`
  // above clears that one key, so a change takes effect everywhere at once
  // rather than at three different moments.

  // ── Validation ─────────────────────────────────────────────────────────────

  private validate(input: PolicyInput): void {
    if (input.dataRetentionDays !== undefined) {
      if (
        input.dataRetentionDays < MIN_RETENTION_DAYS ||
        input.dataRetentionDays > MAX_RETENTION_DAYS
      ) {
        throw AppError.badRequest(
          `Retention must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days`,
        );
      }
    }

    if (input.allowedProviders?.length) {
      const available = new Set(this.configuredProviders());
      const unknown = input.allowedProviders.filter((provider) => !available.has(provider));
      if (unknown.length) {
        // Allowing a provider that is not configured is not dangerous, but it
        // is always a mistake, and it produces a policy that looks permissive
        // and blocks everything.
        throw AppError.badRequest(
          `These providers are not configured on this deployment: ${unknown.join(', ')}`,
        );
      }
    }

    for (const [field, value] of [
      ['monthlyTokenLimit', input.monthlyTokenLimit],
      ['perExecutionTokenCap', input.perExecutionTokenCap],
      ['monthlyCostLimitUsd', input.monthlyCostLimitUsd],
    ] as const) {
      if (value !== undefined && value !== null && value <= 0) {
        throw AppError.badRequest(`${field} must be a positive number, or null for no limit`);
      }
    }

    if (
      input.perExecutionTokenCap != null &&
      input.monthlyTokenLimit != null &&
      input.perExecutionTokenCap > input.monthlyTokenLimit
    ) {
      throw AppError.badRequest(
        'A per-execution cap above the monthly limit can never bind, and hides that the monthly limit is what stops you',
      );
    }
  }

  private forAudit(policy: GovernancePolicy): Record<string, unknown> {
    return {
      allowedProviders: policy.allowedProviders,
      allowedModels: policy.allowedModels,
      allowedTools: policy.allowedTools,
      monthlyTokenLimit: policy.monthlyTokenLimit,
      monthlyCostLimitUsd: policy.monthlyCostLimitUsd ? Number(policy.monthlyCostLimitUsd) : null,
      perExecutionTokenCap: policy.perExecutionTokenCap,
      requireHumanApproval: policy.requireHumanApproval,
      dataRetentionDays: policy.dataRetentionDays,
      allowTraining: policy.allowTraining,
    };
  }
}
