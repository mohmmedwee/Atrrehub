import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { RuntimeService } from '../workflows/runtime.service';
import { AgentsService } from './agents.service';

const VersionSchema = z.object({
  instructions: z.string().min(10).max(20_000).optional(),
  modelRole: z.enum(['chat', 'fast', 'reasoning']).optional(),
  modelOverride: z.string().max(120).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(100_000).optional(),
  knowledgeBaseIds: z.array(z.string()).max(50).optional(),
  toolIds: z.array(z.string().max(60)).max(50).optional(),
  workflowId: z.string().nullable().optional(),
  memoryPolicy: z.record(z.unknown()).optional(),
  guardrailPolicyId: z.string().nullable().optional(),
  handoffRules: z.record(z.unknown()).optional(),
  greeting: z.string().max(2000).optional(),
  fallbackMessage: z.string().max(2000).optional(),
  locales: z.array(z.string().max(10)).max(20).optional(),
});

const CreateAgentSchema = VersionSchema.extend({
  name: z.string().min(2).max(80),
  key: z.string().min(2).max(60).regex(/^[a-z][a-z0-9_-]*$/),
  description: z.string().max(500).optional(),
  workspaceId: z.string().optional(),
}).strict();

const RunSchema = z
  .object({
    message: z.string().min(1).max(20_000),
    conversationId: z.string().optional(),
    customerId: z.string().optional(),
    idempotencyKey: z.string().max(120).optional(),
  })
  .strict();

@ApiTags('AI Agents')
@Controller('agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly runtime: RuntimeService,
  ) {}

  @Get()
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'List AI agents' })
  list() {
    return this.agents.list();
  }

  @Post()
  @RequirePermissions('agent:create')
  @ApiOperation({ summary: 'Create an AI agent with its first draft version' })
  create(@Body(zodBody(CreateAgentSchema)) body: z.infer<typeof CreateAgentSchema>) {
    return this.agents.create(body as never);
  }

  @Get('executions')
  @RequirePermissions('execution:read')
  @ApiOperation({ summary: 'List recent executions' })
  executions(
    @Query('status') status?: string,
    @Query('agentId') agentId?: string,
    @Query('conversationId') conversationId?: string,
  ) {
    return this.runtime.list({ status, agentId, conversationId });
  }

  @Get('executions/:id')
  @RequirePermissions('execution:read')
  @ApiOperation({ summary: 'Execution debugger: steps, LLM calls, tool calls, guardrails, cost' })
  debug(@Param('id') id: string) {
    return this.runtime.debug(id);
  }

  @Post('executions/:id/resume')
  @RequirePermissions('agent:execute')
  @ApiOperation({ summary: 'Resume a suspended execution' })
  async resume(@Param('id') id: string, @Body(zodBody(z.record(z.unknown()))) body: Record<string, unknown>) {
    return { status: await this.runtime.resume(id, body) };
  }

  @Post('executions/:id/cancel')
  @HttpCode(204)
  @RequirePermissions('agent:execute')
  @ApiOperation({ summary: 'Cancel a running execution' })
  async cancel(@Param('id') id: string) {
    await this.runtime.cancel(id);
  }

  @Get(':id')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'Read an agent with its versions' })
  get(@Param('id') id: string) {
    return this.agents.get(id);
  }

  @Patch(':id')
  @RequirePermissions('agent:update')
  @ApiOperation({ summary: 'Edit the draft version; a published version is never modified' })
  updateDraft(@Param('id') id: string, @Body(zodBody(VersionSchema.strict())) body: z.infer<typeof VersionSchema>) {
    return this.agents.updateDraft(id, body as never);
  }

  @Post(':id/publish')
  @RequirePermissions('agent:publish')
  @ApiOperation({ summary: 'Publish the draft into an environment' })
  publish(
    @Param('id') id: string,
    @Body(zodBody(z.object({ environment: z.enum(['development', 'staging', 'production']).default('production') }).strict()))
    body: { environment: 'development' | 'staging' | 'production' },
  ) {
    return this.agents.publish(id, body.environment);
  }

  @Post(':id/rollback')
  @RequirePermissions('agent:publish')
  @ApiOperation({ summary: 'Roll back to a previously published version' })
  rollback(@Param('id') id: string, @Body(zodBody(z.object({ version: z.number().int().min(1) }).strict())) body: { version: number }) {
    return this.agents.rollback(id, body.version);
  }

  @Post(':id/run')
  @RequirePermissions('agent:execute')
  @RateLimit(RATE_BUCKETS.ai)
  @ApiOperation({ summary: 'Run the agent against a message' })
  run(@Param('id') id: string, @Body(zodBody(RunSchema)) body: z.infer<typeof RunSchema>) {
    return this.agents.run({ agentId: id, ...body });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('agent:update')
  @ApiOperation({ summary: 'Delete an agent' })
  async delete(@Param('id') id: string) {
    await this.agents.delete(id);
  }
}
