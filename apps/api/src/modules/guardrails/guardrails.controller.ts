import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { GuardrailsService } from './guardrails.service';

const RuleSchema = z.object({
  stage: z.enum(['input', 'retrieval', 'tool', 'output', 'decision']),
  check: z.string().min(2).max(60),
  action: z.enum(['allow', 'flag', 'mask', 'block', 'handoff']),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  config: z.record(z.unknown()).optional(),
});

const PolicySchema = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(500).optional(),
    rules: z.array(RuleSchema).max(50).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    groundednessMode: z.enum(['off', 'flag', 'block']).optional(),
    maskPii: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

@ApiTags('AI Guardrails')
@Controller('guardrails')
export class GuardrailsController {
  constructor(private readonly guardrails: GuardrailsService) {}

  @Get('policies')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'List guardrail policies' })
  list() {
    return this.guardrails.listPolicies();
  }

  @Post('policies')
  @RequirePermissions('guardrail:manage')
  @ApiOperation({ summary: 'Create a guardrail policy' })
  create(@Body(zodBody(PolicySchema)) body: z.infer<typeof PolicySchema>) {
    return this.guardrails.createPolicy(body as never);
  }

  @Patch('policies/:id')
  @RequirePermissions('guardrail:manage')
  @ApiOperation({ summary: 'Update a guardrail policy' })
  update(
    @Param('id') id: string,
    @Body(zodBody(PolicySchema.partial())) body: Record<string, unknown>,
  ) {
    return this.guardrails.updatePolicy(id, body);
  }

  @Delete('policies/:id')
  @HttpCode(204)
  @RequirePermissions('guardrail:manage')
  @ApiOperation({ summary: 'Delete a guardrail policy' })
  async delete(@Param('id') id: string) {
    await this.guardrails.deletePolicy(id);
  }

  @Get('events')
  @RequirePermissions('execution:read')
  @ApiOperation({ summary: 'Recent guardrail decisions' })
  events() {
    return this.guardrails.recentEvents();
  }
}
