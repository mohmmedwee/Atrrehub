import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiOptionalQuery, ApiZodBody } from '../../core/http/zod-openapi';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { AccessReviewService } from './access-review.service';
import { GovernanceService } from './governance.service';
import { SubjectRightsService } from './subject-rights.service';

const PolicySchema = z
  .object({
    allowedProviders: z.array(z.string().max(40)).max(20).optional(),
    allowedModels: z.array(z.string().max(120)).max(100).optional(),
    allowedTools: z.array(z.string().max(80)).max(200).optional(),
    monthlyTokenLimit: z.number().int().positive().nullable().optional(),
    monthlyCostLimitUsd: z.number().positive().nullable().optional(),
    perExecutionTokenCap: z.number().int().positive().nullable().optional(),
    requireHumanApproval: z.boolean().optional(),
    dataRetentionDays: z.number().int().min(1).max(3650).optional(),
    allowTraining: z.boolean().optional(),
  })
  .strict();

const ReviewSchema = z
  .object({
    decision: z.enum(['approved', 'changes_required']),
    note: z.string().max(2000).optional(),
    revokedUserIds: z.array(z.string().max(40)).max(500).optional(),
  })
  .strict();

@ApiTags('Governance')
@Controller('governance')
export class GovernanceController {
  constructor(
    private readonly governance: GovernanceService,
    private readonly subjects: SubjectRightsService,
    private readonly accessReview: AccessReviewService,
  ) {}

  @Get('policy')
  @RequirePermissions('governance:manage')
  @ApiOperation({ summary: 'The AI governance policy in force' })
  policy() {
    return this.governance.get();
  }

  @Put('policy')
  @RequirePermissions('governance:manage')
  @ApiOperation({ summary: 'Change the policy; takes effect on the next AI call' })
  @ApiZodBody(PolicySchema)
  updatePolicy(@Body(zodBody(PolicySchema)) body: z.infer<typeof PolicySchema>) {
    return this.governance.update(body);
  }

  @Get('policy/catalogue')
  @RequirePermissions('governance:manage')
  @ApiOperation({ summary: 'Providers, tools and limits a policy can choose from' })
  catalogue() {
    return this.governance.catalogue();
  }

  // ── Data subject rights ────────────────────────────────────────────────────

  @Post('subjects/:customerId/export')
  @RequirePermissions('customer:export')
  @ApiOperation({ summary: 'Everything held about a customer, as a stored JSON archive' })
  export(@Param('customerId') customerId: string) {
    return this.subjects.export(customerId);
  }

  @Post('subjects/:customerId/erase')
  @RequirePermissions('customer:delete')
  @ApiOperation({ summary: 'Erase a customer; pass dryRun=true to see what would go' })
  @ApiOptionalQuery('dryRun')
  erase(@Param('customerId') customerId: string, @Query('dryRun') dryRun?: string) {
    return this.subjects.erase(customerId, { dryRun: dryRun === 'true' });
  }

  // ── Access review ──────────────────────────────────────────────────────────

  @Get('access-review')
  @RequirePermissions('governance:manage')
  @ApiOperation({ summary: 'Who holds sensitive access today, and which accounts are dormant' })
  review() {
    return this.accessReview.review();
  }

  @Post('access-review')
  @RequirePermissions('governance:manage')
  @ApiOperation({ summary: 'Record that a review was completed, and what was decided' })
  @ApiZodBody(ReviewSchema)
  completeReview(@Body(zodBody(ReviewSchema)) body: z.infer<typeof ReviewSchema>) {
    return this.accessReview.recordCompletion(body);
  }
}
