import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ToolsService } from './tools.service';

const ToolSchema = z
  .object({
    key: z
      .string()
      .min(2)
      .max(60)
      .regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(2).max(80),
    description: z.string().min(10).max(1000),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    auth: z.record(z.unknown()).optional(),
    inputSchema: z.record(z.unknown()).optional(),
    outputSchema: z.record(z.unknown()).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
    requiresApproval: z.boolean().optional(),
  })
  .strict();

@ApiTags('AI Tools')
@Controller('tools')
export class ToolsController {
  constructor(private readonly tools: ToolsService) {}

  @Get()
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'List built-in and custom tools' })
  list() {
    return this.tools.list();
  }

  @Post()
  @RequirePermissions('tool:manage')
  @ApiOperation({ summary: 'Define a custom HTTP tool' })
  create(@Body(zodBody(ToolSchema)) body: z.infer<typeof ToolSchema>) {
    return this.tools.create(body as never);
  }

  @Patch(':id')
  @RequirePermissions('tool:manage')
  @ApiOperation({ summary: 'Update a custom tool' })
  update(
    @Param('id') id: string,
    @Body(zodBody(ToolSchema.partial())) body: Record<string, unknown>,
  ) {
    return this.tools.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('tool:manage')
  @ApiOperation({ summary: 'Delete a custom tool' })
  async delete(@Param('id') id: string) {
    await this.tools.delete(id);
  }

  @Post(':key/invoke')
  @RequirePermissions('tool:execute')
  @RateLimit(RATE_BUCKETS.ai)
  @ApiOperation({ summary: 'Invoke a tool directly, for testing' })
  invoke(
    @Param('key') key: string,
    @Body(zodBody(z.record(z.unknown()))) body: Record<string, unknown>,
  ) {
    return this.tools.invoke(key, body);
  }

  @Get('invocations/recent')
  @RequirePermissions('execution:read')
  @ApiOperation({ summary: 'Recent tool invocations' })
  invocations() {
    return this.tools.invocations();
  }
}
