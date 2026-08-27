import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { MetricsService } from '../../core/metrics/metrics.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { QUEUES, QueueService, type QueueName } from '../../core/queue/queue.service';
import { AuditService } from '../audit/audit.service';

export interface DeadLetterFilter {
  queue?: string;
  /** Only those an operator has not yet dealt with. */
  outstanding?: boolean;
  limit?: number;
}

/**
 * Jobs that exhausted every retry, and what an operator can do about them.
 *
 * Before this, a job that could never succeed was logged, kept in Redis for a
 * day, and forgotten. Nobody could list what had been lost, and nobody could
 * run it again — so an ingestion job that failed during an outage simply meant
 * a customer's documents were never indexed, silently and permanently.
 */
@Injectable()
export class DeadLetterService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.queue.onDeadLetter(async (letter) => {
      // A job with no tenant cannot be stored against one, and replaying it
      // would have nowhere to run. It is logged loudly and dropped, which is
      // the same outcome as before but now visibly rather than by omission.
      if (!letter.organizationId) {
        this.logger.error('Dead-lettered a job with no tenant', undefined, {
          queue: letter.queue,
          jobId: letter.jobId,
        });
        return;
      }

      await this.prisma.raw.deadLetter.create({
        data: {
          id: newId('deadLetter'),
          organizationId: letter.organizationId,
          queue: letter.queue,
          jobName: letter.jobName,
          jobId: letter.jobId ?? null,
          payload: letter.payload as Prisma.InputJsonValue,
          attempts: letter.attempts,
          error: letter.error.slice(0, 2_000),
          stack: letter.stack?.slice(0, 8_000) ?? null,
        },
      });
      this.metrics.deadLetters.inc({ queue: letter.queue });
    });
    this.logger.info('Dead-letter store attached to the queue tier');
  }

  async list(filter: DeadLetterFilter = {}) {
    return this.prisma.db.deadLetter.findMany({
      where: {
        ...(filter.queue ? { queue: filter.queue } : {}),
        ...(filter.outstanding ? { replayedAt: null, discardedAt: null } : {}),
      },
      orderBy: { failedAt: 'desc' },
      take: Math.min(filter.limit ?? 50, 200),
      select: {
        id: true,
        queue: true,
        jobName: true,
        jobId: true,
        attempts: true,
        error: true,
        failedAt: true,
        replayedAt: true,
        discardedAt: true,
        note: true,
      },
    });
  }

  /** Counts per queue, for an operator dashboard and for an alert rule. */
  async summary() {
    const rows = await this.prisma.db.deadLetter.groupBy({
      by: ['queue'],
      where: { replayedAt: null, discardedAt: null },
      _count: { _all: true },
      _max: { failedAt: true },
    });
    return rows
      .map((row) => ({
        queue: row.queue,
        outstanding: row._count._all,
        mostRecentFailure: row._max.failedAt,
      }))
      .sort((a, b) => b.outstanding - a.outstanding);
  }

  async get(deadLetterId: string) {
    const letter = await this.prisma.db.deadLetter.findUnique({ where: { id: deadLetterId } });
    if (!letter) throw AppError.notFound('Dead letter', deadLetterId);
    return letter;
  }

  /**
   * Put the job back on its queue.
   *
   * The row is marked rather than deleted, and a replay that fails again
   * dead-letters as a new row. An operator therefore sees that they already
   * tried this one — which is the question they ask when the same job appears
   * for the third time.
   */
  async replay(deadLetterId: string) {
    const letter = await this.get(deadLetterId);
    if (letter.discardedAt) throw AppError.badRequest('That job was discarded deliberately');

    const queueName = letter.queue as QueueName;
    if (!Object.values(QUEUES).includes(queueName)) {
      // A queue that no longer exists in this release. Replaying would enqueue
      // onto a queue nothing consumes, which looks like success and is not.
      throw AppError.badRequest(`The queue ${letter.queue} no longer exists in this release`);
    }

    // The payload already carries its `__ctx`, so the job replays inside the
    // tenant it originally belonged to rather than whoever is replaying it.
    const payload = letter.payload as Record<string, unknown>;
    const jobId = await this.queue.enqueue(
      queueName,
      letter.jobName,
      payload,
      { organizationId: letter.organizationId },
    );

    const updated = await this.prisma.db.deadLetter.update({
      where: { id: deadLetterId },
      data: {
        replayedAt: new Date(),
        replayedById: RequestContextStore.principal()?.id ?? null,
      },
    });
    await this.audit.record({
      action: 'deadletter.replayed',
      resourceType: 'dead_letter',
      resourceId: deadLetterId,
      after: { queue: letter.queue, jobName: letter.jobName, newJobId: jobId },
    });
    this.logger.info('Replayed a dead-lettered job', {
      deadLetterId,
      queue: letter.queue,
      newJobId: jobId,
    });
    return { ...updated, newJobId: jobId };
  }

  /** Record that a job should never run again, and why. */
  async discard(deadLetterId: string, note: string) {
    const letter = await this.get(deadLetterId);
    if (letter.replayedAt) throw AppError.badRequest('That job was already replayed');

    const updated = await this.prisma.db.deadLetter.update({
      where: { id: deadLetterId },
      data: { discardedAt: new Date(), note },
    });
    await this.audit.record({
      action: 'deadletter.discarded',
      resourceType: 'dead_letter',
      resourceId: deadLetterId,
      after: { queue: letter.queue, jobName: letter.jobName, note },
    });
    return updated;
  }
}
