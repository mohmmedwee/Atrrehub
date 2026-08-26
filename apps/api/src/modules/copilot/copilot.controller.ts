import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CopilotService } from './copilot.service';

const AssistSchema = z
  .object({
    conversationId: z.string().min(3),
    action: z.enum([
      'suggest_reply',
      'rewrite',
      'summarize',
      'translate',
      'adjust_tone',
      'next_best_action',
      'customer_summary',
    ]),
    draft: z.string().max(20_000).optional(),
    targetLocale: z.string().max(20).optional(),
    tone: z.enum(['formal', 'friendly', 'concise', 'empathetic', 'apologetic']).optional(),
  })
  .strict();

@ApiTags('AI Copilot')
@Controller('copilot')
@RateLimit(RATE_BUCKETS.ai)
export class CopilotController {
  constructor(private readonly copilot: CopilotService) {}

  @Post('assist')
  @RequirePermissions('copilot:execute')
  @ApiOperation({
    summary: 'Suggest, rewrite, summarize, translate, adjust tone or recommend the next action',
  })
  assist(@Body(zodBody(AssistSchema)) body: z.infer<typeof AssistSchema>) {
    return this.copilot.assist(body);
  }

  @Get('customers/:id/context')
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'AI customer context for the workspace rail' })
  customerContext(@Param('id') id: string) {
    return this.copilot.customerSummary(id);
  }

  @Post('customers/:id/context/refresh')
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'Regenerate the AI customer context' })
  refreshContext(@Param('id') id: string) {
    return this.copilot.customerSummary(id, true);
  }
}
