import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { zodQuery } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { IntelligenceService } from '../intelligence/intelligence.service';
import { AnalyticsService } from './analytics.service';

const RangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const DEFAULT_DAYS = 30;

function resolveRange(query: z.infer<typeof RangeQuery>) {
  return {
    from: query.from ?? new Date(Date.now() - DEFAULT_DAYS * 86_400_000),
    to: query.to ?? new Date(),
  };
}

@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly intelligence: IntelligenceService,
  ) {}

  @Get('executive')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Executive dashboard: volume, resolution, AI deflection, CSAT, SLA, cost',
  })
  executive(@Query(zodQuery(RangeQuery)) query: z.infer<typeof RangeQuery>) {
    return this.analytics.executive(resolveRange(query));
  }

  @Get('agents')
  @RequirePermissions('analytics:read_all')
  @ApiOperation({ summary: 'Agent performance: AHT, FCR, CSAT, QA score' })
  agents(@Query(zodQuery(RangeQuery)) query: z.infer<typeof RangeQuery>) {
    return this.analytics.agentPerformance(resolveRange(query));
  }

  @Get('ai')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'AI performance: deflection, handoff, tokens, cost, latency, guardrails',
  })
  ai(@Query(zodQuery(RangeQuery)) query: z.infer<typeof RangeQuery>) {
    return this.analytics.aiPerformance(resolveRange(query));
  }

  @Get('channels')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Channel performance' })
  channels(@Query(zodQuery(RangeQuery)) query: z.infer<typeof RangeQuery>) {
    return this.analytics.channelPerformance(resolveRange(query));
  }

  @Get('series/:metric')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'A daily time series for charting' })
  series(
    @Param('metric') metric: 'conversations' | 'resolutions' | 'ai_cost' | 'messages',
    @Query(zodQuery(RangeQuery)) query: z.infer<typeof RangeQuery>,
  ) {
    return this.analytics.timeSeries(resolveRange(query), metric);
  }

  @Get('live')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Live operational snapshot for the wallboard' })
  live() {
    return this.analytics.liveSnapshot();
  }

  @Get('intelligence')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Intent, topic, complaint and sentiment trends' })
  intelligenceTrends(@Query(zodQuery(RangeQuery)) query: z.infer<typeof RangeQuery>) {
    return this.intelligence.trends(resolveRange(query));
  }

  @Get('conversations/:id/intelligence')
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'Extracted intelligence for one conversation' })
  conversationIntelligence(@Param('id') id: string) {
    return this.intelligence.get(id);
  }

  @Post('conversations/:id/intelligence')
  @RequirePermissions('conversation:read')
  @RateLimit(RATE_BUCKETS.ai)
  @ApiOperation({ summary: 'Extract intelligence for a conversation now' })
  extract(@Param('id') id: string) {
    return this.intelligence.extract(id);
  }
}
