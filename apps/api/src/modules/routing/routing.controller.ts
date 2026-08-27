import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { ApiZodBody } from '../../core/http/zod-openapi';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { RoutingService } from './routing.service';

const StrategyEnum = z.enum([
  'round_robin',
  'least_loaded',
  'skill_based',
  'language',
  'priority',
  'customer_tier',
  'team',
  'ai_intent',
  'sentiment',
  'direct',
]);

const RuleSchema = z
  .object({
    name: z.string().min(2).max(80),
    position: z.number().int().min(0).max(999).optional(),
    strategy: StrategyEnum.optional(),
    conditions: z.record(z.unknown()).optional(),
    targetQueueId: z.string().optional(),
    targetTeamId: z.string().optional(),
    targetUserId: z.string().optional(),
    targetAgentId: z.string().optional(),
    requireSkills: z.array(z.string().max(40)).max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

@ApiTags('Routing')
@Controller('routing')
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Get('rules')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'List routing rules in evaluation order' })
  listRules() {
    return this.routing.listRules();
  }

  @Post('rules')
  @RequirePermissions('routing:manage')
  @ApiOperation({ summary: 'Create a routing rule' })
  @ApiZodBody(RuleSchema)
  createRule(@Body(zodBody(RuleSchema)) body: z.infer<typeof RuleSchema>) {
    return this.routing.createRule(body as never);
  }

  @Patch('rules/:id')
  @RequirePermissions('routing:manage')
  @ApiOperation({ summary: 'Update a routing rule' })
  @ApiZodBody(RuleSchema.partial())
  updateRule(
    @Param('id') id: string,
    @Body(zodBody(RuleSchema.partial())) body: Record<string, unknown>,
  ) {
    return this.routing.updateRule(id, body);
  }

  @Delete('rules/:id')
  @HttpCode(204)
  @RequirePermissions('routing:manage')
  @ApiOperation({ summary: 'Delete a routing rule' })
  async deleteRule(@Param('id') id: string) {
    await this.routing.deleteRule(id);
  }

  @Post('conversations/:id/route')
  @RequirePermissions('conversation:assign')
  @ApiOperation({ summary: 'Route a conversation now' })
  route(@Param('id') id: string) {
    return this.routing.route(id);
  }

  @Get('conversations/:id/simulate')
  @RequirePermissions('routing:manage')
  @ApiOperation({ summary: 'Preview the routing decision without applying it' })
  simulate(@Param('id') id: string) {
    return this.routing.simulate(id);
  }

  @Post('queues/:id/drain')
  @RequirePermissions('conversation:assign')
  @ApiOperation({ summary: 'Assign queued conversations while capacity allows' })
  async drain(@Param('id') id: string) {
    return { assigned: await this.routing.drainQueue(id) };
  }
}
