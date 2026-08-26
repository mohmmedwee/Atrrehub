import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from 'bullmq';
import { RequestContextStore } from '../context/request-context';
import { AppLogger } from '../logger/logger.service';

/** Every background queue in the platform. */
export const QUEUES = {
  ingestion: 'ingestion',
  embedding: 'embedding',
  execution: 'execution',
  sla: 'sla',
  automation: 'automation',
  quality: 'quality',
  intelligence: 'intelligence',
  notification: 'notification',
  webhook: 'webhook',
  email: 'email',
  analytics: 'analytics',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Carried on every job so workers can restore the originating tenant context. */
export interface JobContext {
  organizationId: string;
  workspaceId?: string;
  requestId?: string;
}

export type JobPayload<T> = T & { __ctx: JobContext };

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86_400 },
};

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly logger: AppLogger,
    private readonly concurrency: number,
  ) {}

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Enqueue a job, stamping it with the current tenant so the worker can restore it. */
  async enqueue<T extends object>(
    name: QueueName,
    jobName: string,
    data: T,
    options?: JobsOptions & { organizationId?: string },
  ): Promise<string | undefined> {
    const context = RequestContextStore.get();
    const organizationId = options?.organizationId ?? context?.organizationId;
    if (!organizationId)
      throw new Error(`Cannot enqueue ${name}/${jobName} without an organization`);

    const payload: JobPayload<T> = {
      ...data,
      __ctx: { organizationId, workspaceId: context?.workspaceId, requestId: context?.requestId },
    };
    const job = await this.queue(name).add(jobName, payload, { ...options });
    return job.id;
  }

  /** Schedule a repeatable job; safe to call on every boot. */
  async schedule<T extends object>(
    name: QueueName,
    jobName: string,
    data: T & { organizationId: string },
    pattern: string,
  ): Promise<void> {
    await this.queue(name).add(
      jobName,
      { ...data, __ctx: { organizationId: data.organizationId } },
      { repeat: { pattern }, jobId: `repeat:${jobName}:${data.organizationId}` },
    );
  }

  /**
   * Register a consumer. The handler runs inside the job's tenant context, so
   * every database call it makes is scoped exactly as an HTTP request would be.
   */
  register<T>(name: QueueName, processor: (data: T, jobId: string) => Promise<unknown>): Worker {
    const handler: Processor = async (job) => {
      const payload = job.data as JobPayload<T>;
      const ctx = payload.__ctx;
      // `runAsync` awaits inside the scope, so a handler returning a lazy
      // promise still executes with the job's tenant context in place.
      return RequestContextStore.runAsync(
        {
          requestId: ctx?.requestId ?? `job-${job.id}`,
          organizationId: ctx?.organizationId,
          workspaceId: ctx?.workspaceId,
          startedAt: Date.now(),
          principal: { type: 'worker', id: `worker:${name}`, permissions: ['*'] },
        },
        () => processor(payload, String(job.id)),
      );
    };

    const worker = new Worker(name, handler, {
      connection: this.connection,
      concurrency: this.concurrency,
    });
    worker.on('failed', (job, error) =>
      this.logger.error('Job failed', error, {
        queue: name,
        jobId: job?.id,
        attempts: job?.attemptsMade,
      }),
    );
    worker.on('error', (error) => this.logger.error('Worker error', error, { queue: name }));
    this.workers.push(worker);
    return worker;
  }

  async counts(name: QueueName) {
    return this.queue(name).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
  }
}
