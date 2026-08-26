import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { SlaService } from './sla.service';

const TargetTypeEnum = z.enum(['first_response', 'next_response', 'resolution', 'waiting']);
const PriorityEnum = z.enum(['low', 'normal', 'high', 'urgent', 'critical']);

const PolicySchema = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(300).optional(),
    businessHoursId: z.string().optional(),
    conditions: z.record(z.unknown()).optional(),
    isDefault: z.boolean().optional(),
    targets: z
      .array(
        z
          .object({
            type: TargetTypeEnum,
            priority: PriorityEnum,
            durationMinutes: z.number().int().min(1).max(100_000),
            warningPercent: z.number().int().min(1).max(99).optional(),
            escalateToTeamId: z.string().optional(),
            escalateToUserId: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();

const AttainmentQuery = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  type: TargetTypeEnum.optional(),
});

@ApiTags('SLA')
@Controller('sla')
export class SlaController {
  constructor(private readonly sla: SlaService) {}

  @Get('policies')
  @RequirePermissions('sla:read')
  @ApiOperation({ summary: 'List SLA policies and their targets' })
  listPolicies() {
    return this.sla.listPolicies();
  }

  @Post('policies')
  @RequirePermissions('sla:manage')
  @ApiOperation({ summary: 'Create an SLA policy' })
  createPolicy(@Body(zodBody(PolicySchema)) body: z.infer<typeof PolicySchema>) {
    return this.sla.createPolicy(body as never);
  }

  @Get('policies/:id')
  @RequirePermissions('sla:read')
  @ApiOperation({ summary: 'Read an SLA policy' })
  getPolicy(@Param('id') id: string) {
    return this.sla.getPolicy(id);
  }

  @Patch('policies/:id')
  @RequirePermissions('sla:manage')
  @ApiOperation({ summary: 'Update an SLA policy' })
  updatePolicy(@Param('id') id: string, @Body(zodBody(PolicySchema.partial().omit({ targets: true }))) body: Record<string, unknown>) {
    return this.sla.updatePolicy(id, body);
  }

  @Delete('policies/:id')
  @HttpCode(204)
  @RequirePermissions('sla:manage')
  @ApiOperation({ summary: 'Delete an SLA policy' })
  async deletePolicy(@Param('id') id: string) {
    await this.sla.deletePolicy(id);
  }

  @Get('clocks/:subjectType/:subjectId')
  @RequirePermissions('sla:read')
  @ApiOperation({ summary: 'SLA clocks for a conversation or ticket' })
  clocks(@Param('subjectType') subjectType: 'conversation' | 'ticket', @Param('subjectId') subjectId: string) {
    return this.sla.clocksFor(subjectType, subjectId);
  }

  @Get('attainment')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'SLA attainment over a period' })
  attainment(@Query(zodQuery(AttainmentQuery)) query: z.infer<typeof AttainmentQuery>) {
    return this.sla.attainment(query);
  }

  @Post('sweep')
  @RequirePermissions('sla:manage')
  @ApiOperation({ summary: 'Run the SLA sweep immediately' })
  sweep() {
    return this.sla.sweep();
  }
}
