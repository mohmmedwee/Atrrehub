import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { ApiOptionalQuery, ApiZodBody } from '../../core/http/zod-openapi';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { QualityService } from './quality.service';

const CriterionSchema = z.object({
  category: z.string().min(1).max(60),
  name: z.string().min(1).max(60),
  description: z.string().max(300).optional(),
  weight: z.number().int().min(1).max(100),
  rubric: z.string().min(10).max(2000),
  isCritical: z.boolean().optional(),
});

const TemplateSchema = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(500).optional(),
    channels: z.array(z.string().max(30)).max(15).optional(),
    autoEvaluate: z.boolean().optional(),
    samplePercent: z.number().int().min(1).max(100).optional(),
    passingScore: z.number().int().min(0).max(100).optional(),
    criteria: z.array(CriterionSchema).min(1).max(30).optional(),
  })
  .strict();

const ManualSchema = z
  .object({
    conversationId: z.string().min(3),
    templateId: z.string().min(3),
    scores: z
      .array(
        z.object({
          criterionId: z.string(),
          score: z.number().min(0).max(100),
          reasoning: z.string().max(1000).optional(),
        }),
      )
      .min(1),
    reasoning: z.string().max(4000).optional(),
    strengths: z.array(z.string().max(300)).max(10).optional(),
    improvements: z.array(z.string().max(300)).max(10).optional(),
  })
  .strict();

@ApiTags('Quality Management')
@Controller('quality')
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  @Get('templates')
  @RequirePermissions('qc:read_own')
  @ApiOperation({ summary: 'List QC scorecard templates' })
  listTemplates() {
    return this.quality.listTemplates();
  }

  @Post('templates')
  @RequirePermissions('qc:template_manage')
  @ApiOperation({ summary: 'Create a QC template; criterion weights must total 100' })
  @ApiZodBody(TemplateSchema)
  createTemplate(@Body(zodBody(TemplateSchema)) body: z.infer<typeof TemplateSchema>) {
    return this.quality.createTemplate(body);
  }

  @Patch('templates/:id')
  @RequirePermissions('qc:template_manage')
  @ApiOperation({ summary: 'Update a QC template' })
  updateTemplate(
    @Param('id') id: string,
    @Body(zodBody(TemplateSchema.partial().omit({ criteria: true }))) body: Record<string, unknown>,
  ) {
    return this.quality.updateTemplate(id, body);
  }

  @Delete('templates/:id')
  @HttpCode(204)
  @RequirePermissions('qc:template_manage')
  @ApiOperation({ summary: 'Delete a QC template' })
  async deleteTemplate(@Param('id') id: string) {
    await this.quality.deleteTemplate(id);
  }

  @Get('evaluations')
  @RequirePermissions('qc:read_own')
  @ApiOperation({ summary: 'List evaluations' })
  @ApiOptionalQuery('subjectId', 'templateId')
  listEvaluations(
    @Query('subjectId') subjectId?: string,
    @Query('templateId') templateId?: string,
  ) {
    return this.quality.listEvaluations({ subjectId, templateId });
  }

  @Get('evaluations/:id')
  @RequirePermissions('qc:read_own')
  @ApiOperation({ summary: 'Read an evaluation with per-criterion scores and evidence' })
  getEvaluation(@Param('id') id: string) {
    return this.quality.getEvaluation(id);
  }

  @Post('evaluate/:conversationId')
  @RequirePermissions('qc:evaluate')
  @RateLimit(RATE_BUCKETS.ai)
  @ApiOperation({ summary: 'Run an AI evaluation of a conversation' })
  @ApiOptionalQuery('templateId')
  evaluate(
    @Param('conversationId') conversationId: string,
    @Query('templateId') templateId?: string,
  ) {
    return this.quality.evaluateConversation(conversationId, templateId);
  }

  @Post('evaluations/manual')
  @RequirePermissions('qc:evaluate')
  @ApiOperation({ summary: 'Record a manual evaluation' })
  @ApiZodBody(ManualSchema)
  manual(@Body(zodBody(ManualSchema)) body: z.infer<typeof ManualSchema>) {
    return this.quality.manualEvaluation(body);
  }

  @Post('evaluations/:id/dispute')
  @RequirePermissions('qc:dispute')
  @ApiOperation({ summary: 'Dispute an evaluation' })
  dispute(
    @Param('id') id: string,
    @Body(zodBody(z.object({ reason: z.string().min(10).max(2000) }).strict()))
    body: { reason: string },
  ) {
    return this.quality.raiseDispute(id, body.reason);
  }

  @Post('disputes/:id/resolve')
  @RequirePermissions('qc:calibrate')
  @ApiOperation({ summary: 'Resolve a dispute, optionally overriding the score' })
  resolveDispute(
    @Param('id') id: string,
    @Body(
      zodBody(
        z
          .object({
            resolution: z.string().min(5).max(2000),
            resolvedScore: z.number().min(0).max(100).optional(),
          })
          .strict(),
      ),
    )
    body: { resolution: string; resolvedScore?: number },
  ) {
    return this.quality.resolveDispute(id, body);
  }

  @Get('calibration/:templateId')
  @RequirePermissions('qc:calibrate')
  @ApiOperation({ summary: 'Evaluator drift against the AI baseline' })
  calibration(@Param('templateId') templateId: string) {
    return this.quality.calibration(templateId);
  }

  @Get('signals/:conversationId')
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'Real-time quality signals for a conversation' })
  signals(@Param('conversationId') conversationId: string) {
    return this.quality.listSignals(conversationId);
  }

  @Post('signals/:id/acknowledge')
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'Acknowledge a real-time signal' })
  acknowledge(@Param('id') id: string) {
    return this.quality.acknowledgeSignal(id);
  }

  @Post('monitor/:conversationId')
  @RequirePermissions('qc:evaluate')
  @RateLimit(RATE_BUCKETS.ai)
  @ApiOperation({ summary: 'Run live quality monitoring now' })
  monitor(@Param('conversationId') conversationId: string) {
    return this.quality.monitorLive(conversationId);
  }
}
