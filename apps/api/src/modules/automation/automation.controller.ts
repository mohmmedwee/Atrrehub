import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { AutomationService } from './automation.service';

const TriggerEnum = z.enum([
  'ticket_created', 'ticket_updated', 'message_received', 'conversation_created', 'conversation_resolved',
  'sla_warning', 'sla_breach', 'customer_created', 'sentiment_changed', 'schedule', 'webhook',
]);

const ConditionSchema = z.object({
  field: z.string().min(1).max(120),
  op: z.enum(['eq', 'neq', 'in', 'contains', 'gt', 'lt', 'exists', 'not_exists']),
  value: z.unknown().optional(),
});

const ActionSchema = z.object({
  type: z.enum(['assign', 'send_message', 'send_email', 'create_ticket', 'update_ticket', 'update_customer', 'set_priority', 'add_tag', 'escalate', 'webhook']),
  config: z.record(z.unknown()).default({}),
});

const RuleSchema = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(500).optional(),
    trigger: TriggerEnum,
    schedule: z.string().max(60).optional(),
    conditions: z
      .object({
        all: z.array(ConditionSchema).max(20).optional(),
        any: z.array(ConditionSchema).max(20).optional(),
        expression: z.string().max(1000).optional(),
      })
      .optional(),
    actions: z.array(ActionSchema).min(1).max(10),
    position: z.number().int().min(0).max(999).optional(),
    isActive: z.boolean().optional(),
    workspaceId: z.string().optional(),
  })
  .strict();

@ApiTags('Automation')
@Controller('automation')
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get('rules')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'List automation rules' })
  list() {
    return this.automation.list();
  }

  @Post('rules')
  @RequirePermissions('automation:manage')
  @ApiOperation({ summary: 'Create an automation rule' })
  create(@Body(zodBody(RuleSchema)) body: z.infer<typeof RuleSchema>) {
    return this.automation.create(body as never);
  }

  @Patch('rules/:id')
  @RequirePermissions('automation:manage')
  @ApiOperation({ summary: 'Update an automation rule' })
  update(@Param('id') id: string, @Body(zodBody(RuleSchema.partial())) body: Record<string, unknown>) {
    return this.automation.update(id, body);
  }

  @Delete('rules/:id')
  @HttpCode(204)
  @RequirePermissions('automation:manage')
  @ApiOperation({ summary: 'Delete an automation rule' })
  async delete(@Param('id') id: string) {
    await this.automation.delete(id);
  }

  @Get('runs')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'Recent automation runs' })
  runs(@Query('ruleId') ruleId?: string) {
    return this.automation.runs(ruleId);
  }

  @Post('simulate')
  @RequirePermissions('automation:manage')
  @ApiOperation({ summary: 'Preview which rules would fire, without running them' })
  simulate(
    @Body(zodBody(z.object({ trigger: TriggerEnum, subjectType: z.string().max(40), subjectId: z.string().min(3) }).strict()))
    body: { trigger: z.infer<typeof TriggerEnum>; subjectType: string; subjectId: string },
  ) {
    return this.automation.simulate(body.trigger, { type: body.subjectType, id: body.subjectId });
  }
}
