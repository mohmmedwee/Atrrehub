import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { BillingService } from './billing.service';
import { MetricsRollupService } from './metrics-rollup.service';
import { ProvisioningService } from './provisioning.service';

const PlanEnum = z.enum(['starter', 'professional', 'business', 'enterprise']);

const ChangePlanSchema = z
  .object({ plan: PlanEnum, seats: z.number().int().min(1).max(10_000).optional(), reason: z.string().max(300).optional() })
  .strict();

const OverrideSchema = z
  .object({
    overrides: z.record(z.union([z.number().int().min(0), z.null()])),
    reason: z.string().min(3).max(300),
  })
  .strict();

const ProvisionSchema = z
  .object({
    organizationName: z.string().min(2).max(120),
    ownerEmail: z.string().email(),
    ownerFirstName: z.string().min(1).max(80),
    ownerLastName: z.string().min(1).max(80),
    plan: PlanEnum.optional(),
    slug: z.string().max(60).optional(),
    timezone: z.string().max(60).optional(),
    locale: z.string().max(10).optional(),
    seats: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

const SeriesQuery = z.object({
  metric: z.string().min(3).max(60),
  from: z.coerce.date(),
  to: z.coerce.date(),
  dimensionValue: z.string().max(60).optional(),
});

@ApiTags('Billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly metrics: MetricsRollupService,
    private readonly provisioning: ProvisioningService,
  ) {}

  @Get('plans')
  @RequirePermissions('billing:read')
  @ApiOperation({ summary: 'Plans and what each one allows' })
  plans() {
    return this.billing.catalogue();
  }

  @Get('subscription')
  @RequirePermissions('billing:read')
  @ApiOperation({ summary: 'This organization’s subscription' })
  subscription() {
    return this.billing.subscription();
  }

  @Get('usage')
  @RequirePermissions('billing:read')
  @ApiOperation({ summary: 'Every limit, what is used against it, and what is close' })
  usage() {
    return this.billing.usage();
  }

  @Get('usage/history')
  @RequirePermissions('billing:read')
  @ApiOperation({ summary: 'Recorded usage by period, as billing would count it' })
  history(@Query('months') months?: string) {
    return this.billing.usageHistory(months ? Number(months) : undefined);
  }

  @Get('invoice-estimate')
  @RequirePermissions('billing:read')
  @ApiOperation({ summary: 'What this period would cost at list price' })
  estimate() {
    return this.billing.estimateInvoice();
  }

  @Post('plan')
  @RequirePermissions('billing:manage')
  @ApiOperation({ summary: 'Change plan; a downgrade below current usage is refused' })
  changePlan(@Body(zodBody(ChangePlanSchema)) body: z.infer<typeof ChangePlanSchema>) {
    return this.billing.changePlan(body.plan, { seats: body.seats, reason: body.reason });
  }

  @Post('limits')
  @RequirePermissions('billing:manage')
  @ApiOperation({ summary: 'Record a negotiated limit override against the subscription' })
  overrides(@Body(zodBody(OverrideSchema)) body: z.infer<typeof OverrideSchema>) {
    return this.billing.setLimitOverrides(body.overrides as never, body.reason);
  }

  // ── Analytics rollups ──────────────────────────────────────────────────────

  @Get('metrics/catalogue')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Metrics the daily rollup produces' })
  metricCatalogue() {
    return this.metrics.catalogue();
  }

  @Get('metrics/series')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'A daily series from the rollup table rather than live tables' })
  series(@Query(zodQuery(SeriesQuery)) query: z.infer<typeof SeriesQuery>) {
    return this.metrics.series(query);
  }

  @Post('metrics/backfill')
  @RequirePermissions('analytics:read_all')
  @ApiOperation({ summary: 'Recompute a range of days, to repair a gap in the rollups' })
  async backfill(
    @Body(zodBody(z.object({ from: z.coerce.date(), to: z.coerce.date() }).strict()))
    body: { from: Date; to: Date },
  ) {
    const subscription = await this.billing.subscription();
    const rows = await this.metrics.backfill(subscription.organizationId, body.from, body.to);
    return { rows };
  }

  // ── Tenant provisioning ────────────────────────────────────────────────────

  /**
   * Unauthenticated by the platform's own scheme, because this endpoint
   * *creates* tenants and so cannot belong to one. It carries a provisioning
   * key held outside every tenant, and is disabled unless that key is set.
   */
  @Public()
  @Post('tenants')
  @ApiOperation({ summary: 'Provision a tenant, its owner and its subscription' })
  provision(
    @Headers('x-provisioning-key') key: string | undefined,
    @Body(zodBody(ProvisionSchema)) body: z.infer<typeof ProvisionSchema>,
  ) {
    this.provisioning.authorize(key);
    return this.provisioning.provision(body);
  }

  @Public()
  @Get('tenants')
  @ApiOperation({ summary: 'List tenants and their plans' })
  tenants(@Headers('x-provisioning-key') key: string | undefined) {
    this.provisioning.authorize(key);
    return this.provisioning.list();
  }

  @Public()
  @Post('tenants/:organizationId/suspend')
  @ApiOperation({ summary: 'Suspend a tenant and revoke its sessions' })
  suspend(
    @Headers('x-provisioning-key') key: string | undefined,
    @Param('organizationId') organizationId: string,
  ) {
    this.provisioning.authorize(key);
    return this.provisioning.setStatus(organizationId, 'suspended');
  }

  @Public()
  @Post('tenants/:organizationId/resume')
  @ApiOperation({ summary: 'Return a suspended tenant to service' })
  resume(
    @Headers('x-provisioning-key') key: string | undefined,
    @Param('organizationId') organizationId: string,
  ) {
    this.provisioning.authorize(key);
    return this.provisioning.setStatus(organizationId, 'active');
  }
}
