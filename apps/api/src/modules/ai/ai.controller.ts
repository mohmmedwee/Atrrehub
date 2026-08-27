import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery } from '../../core/http/zod-openapi';
import { CurrentOrg } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { AiGateway } from './gateway.service';

const RouteSchema = z
  .object({
    role: z.enum(['chat', 'fast', 'reasoning', 'embedding', 'rerank']),
    provider: z.enum(['local', 'openai', 'azure_openai', 'anthropic', 'gemini', 'custom']),
    model: z.string().min(1).max(120),
    fallbacks: z
      .array(
        z.object({
          provider: z.enum(['local', 'openai', 'azure_openai', 'anthropic', 'gemini', 'custom']),
          model: z.string().min(1).max(120),
        }),
      )
      .max(5)
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(200_000).optional(),
  })
  .strict();

const UsageQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

@ApiTags('AI Gateway')
@Controller('ai')
export class AiController {
  constructor(private readonly gateway: AiGateway) {}

  @Get('models')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'Model routes, configured providers and defaults' })
  listRoutes(@CurrentOrg() organizationId: string) {
    return this.gateway.listRoutes(organizationId);
  }

  @Put('models')
  @RequirePermissions('governance:manage')
  @ApiOperation({ summary: 'Set the model route for a role' })
  @ApiZodBody(RouteSchema)
  upsertRoute(@Body(zodBody(RouteSchema)) body: z.infer<typeof RouteSchema>) {
    return this.gateway.upsertRoute(body as never);
  }

  @Get('usage')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Token and cost usage by model' })
  @ApiZodQuery(UsageQuery)
  usage(@Query(zodQuery(UsageQuery)) query: z.infer<typeof UsageQuery>) {
    return this.gateway.usageSummary({
      from: query.from ?? new Date(Date.now() - 30 * 86_400_000),
      to: query.to ?? new Date(),
    });
  }

  @Post('test')
  @RequirePermissions('agent:execute')
  @RateLimit(RATE_BUCKETS.ai)
  @ApiOperation({ summary: 'Send a prompt through the gateway to verify routing' })
  async test(
    @Body(
      zodBody(
        z
          .object({
            prompt: z.string().min(1).max(4000),
            role: z.enum(['chat', 'fast', 'reasoning']).default('chat'),
          })
          .strict(),
      ),
    )
    body: {
      prompt: string;
      role: 'chat' | 'fast' | 'reasoning';
    },
  ) {
    const response = await this.gateway.complete(
      { messages: [{ role: 'user', content: body.prompt }] },
      { role: body.role, operation: 'test' },
    );
    return {
      content: response.content,
      model: response.model,
      usage: response.usage,
      finishReason: response.finishReason,
      confidence: response.confidence,
    };
  }
}
