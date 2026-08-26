import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../modules/auth/decorators/public.decorator';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { raw } from '../http/response.interceptor';

@ApiTags('Platform')
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  /** Liveness: the process is up. Deliberately does not touch dependencies. */
  @Public()
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return raw({ status: 'ok', uptime: Math.round(process.uptime()) });
  }

  /** Readiness: the process can serve traffic, dependencies included. */
  @Public()
  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe' })
  async ready() {
    const [database, cache] = await Promise.all([this.prisma.ping(), this.redis.ping()]);
    const status = database && cache ? 'ok' : 'degraded';
    return raw({ status, checks: { database, cache } });
  }

  @Public()
  @Get('metrics')
  @ApiExcludeEndpoint()
  async scrape() {
    return raw({ __text: await this.metrics.scrape() });
  }
}
