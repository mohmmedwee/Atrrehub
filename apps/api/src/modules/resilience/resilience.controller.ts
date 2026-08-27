import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiOptionalQuery, ApiZodBody } from '../../core/http/zod-openapi';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { DeadLetterService } from './dead-letter.service';
import { PartitionService } from './partition.service';

const DiscardSchema = z.object({ note: z.string().min(5).max(1000) }).strict();

@ApiTags('Resilience')
@Controller('resilience')
export class ResilienceController {
  constructor(
    private readonly deadLetters: DeadLetterService,
    private readonly partitions: PartitionService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('dead-letters')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Jobs that exhausted every retry' })
  @ApiOptionalQuery('queue', 'outstanding', 'limit')
  list(
    @Query('queue') queue?: string,
    @Query('outstanding') outstanding?: string,
    @Query('limit') limit?: string,
  ) {
    return this.deadLetters.list({
      queue,
      // Defaults to the outstanding ones: an operator opening this list wants
      // what still needs a decision, not everything that ever failed.
      outstanding: outstanding !== 'false',
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('dead-letters/summary')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Outstanding dead letters per queue' })
  summary() {
    return this.deadLetters.summary();
  }

  @Get('dead-letters/:deadLetterId')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'One dead letter, with its payload and stack' })
  get(@Param('deadLetterId') deadLetterId: string) {
    return this.deadLetters.get(deadLetterId);
  }

  @Post('dead-letters/:deadLetterId/replay')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Put the job back on its queue, in its original tenant' })
  replay(@Param('deadLetterId') deadLetterId: string) {
    return this.deadLetters.replay(deadLetterId);
  }

  @Post('dead-letters/:deadLetterId/discard')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Record that a job should never run again, and why' })
  @ApiZodBody(DiscardSchema)
  discard(
    @Param('deadLetterId') deadLetterId: string,
    @Body(zodBody(DiscardSchema)) body: z.infer<typeof DiscardSchema>,
  ) {
    return this.deadLetters.discard(deadLetterId, body.note);
  }

  @Get('replica')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Whether reads are served by a replica, and how far behind it is' })
  async replica() {
    return {
      configured: this.prisma.hasReplica,
      lagSeconds: await this.prisma.replicaLagSeconds(),
    };
  }

  @Get('partitions')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Partitioned tables, their retention and the partitions that exist' })
  partitionState() {
    return this.partitions.describe();
  }

  @Post('partitions/maintain')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Create missing partitions and drop expired ones now' })
  maintainPartitions() {
    return this.partitions.maintain();
  }
}
