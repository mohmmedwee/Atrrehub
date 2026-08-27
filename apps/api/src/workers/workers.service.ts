import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { AppConfig } from '../config/configuration';
import { RequestContextStore } from '../core/context/request-context';
import { OutboxRelay } from '../core/events/outbox.relay';
import { AppLogger } from '../core/logger/logger.service';
import { MetricsService } from '../core/metrics/metrics.service';
import { PrismaService } from '../core/prisma/prisma.service';
import { QUEUES, QueueService } from '../core/queue/queue.service';
import { KnowledgeService } from '../modules/knowledge/knowledge.service';
import { MemoryService } from '../modules/memory/memory.service';
import { QualityService } from '../modules/quality/quality.service';
import { ReportsService } from '../modules/reports/reports.service';
import { TenancyService } from '../modules/tenancy/tenancy.service';
import { BillingService } from '../modules/billing/billing.service';
import { MetricsRollupService } from '../modules/billing/metrics-rollup.service';
import { BackupService } from '../modules/dr/backup.service';
import { HybridService } from '../modules/hybrid/hybrid.service';
import { WfmService } from '../modules/wfm/wfm.service';
import { IntegrationsService } from '../modules/integrations/integrations.service';
import { WebhooksService } from '../modules/webhooks/webhooks.service';
import { PartitionService } from '../modules/resilience/partition.service';
import { IntelligenceService } from '../modules/intelligence/intelligence.service';
import { RuntimeService } from '../modules/workflows/runtime.service';
import { SlaService } from '../modules/sla/sla.service';

/**
 * The worker tier.
 *
 * Everything that must not happen on the request path lives here: ingestion,
 * embeddings, quality evaluation, SLA sweeps, execution resumption, retention
 * and the outbox relay. Each consumer runs inside the job's tenant context, so
 * the same code is correctly scoped whether it is called from HTTP or a queue.
 */
@Injectable()
export class WorkersService implements OnApplicationBootstrap {
  constructor(
    private readonly config: ConfigService<AppConfig>,
    private readonly queue: QueueService,
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRelay,
    private readonly sla: SlaService,
    private readonly runtime: RuntimeService,
    private readonly knowledge: KnowledgeService,
    private readonly quality: QualityService,
    private readonly reports: ReportsService,
    private readonly tenancy: TenancyService,
    private readonly wfm: WfmService,
    private readonly hybrid: HybridService,
    private readonly backups: BackupService,
    private readonly billing: BillingService,
    private readonly metricsRollup: MetricsRollupService,
    private readonly intelligence: IntelligenceService,
    private readonly integrations: IntegrationsService,
    private readonly webhooks: WebhooksService,
    private readonly partitions: PartitionService,
    private readonly memory: MemoryService,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  private get enabled(): boolean {
    return this.config.get('workers', { infer: true })?.enabled ?? true;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.info('Worker tier disabled by configuration');
      return;
    }

    // A release that adds a permission leaves every existing tenant's system
    // roles stale, so the feature ships and nobody can reach it. Reconcile
    // once at boot, before any request arrives.
    void RequestContextStore.runAsSystem(() => this.tenancy.syncSystemRoles())
      .then((updated) => {
        if (updated) this.logger.info('System roles reconciled', { roles: updated });
      })
      .catch((error) => this.logger.error('Reconciling system roles failed', error));

    this.queue.register<{ documentId: string }>(QUEUES.ingestion, async (data) => {
      await this.knowledge.processDocument(data.documentId);
    });

    this.queue.register<{ conversationId: string }>(QUEUES.quality, async (data, jobId) => {
      // One consumer serves both quality jobs; the job name distinguishes them.
      if (jobId.includes('monitor')) return;
      await this.quality.evaluateConversation(data.conversationId).catch((error) => {
        this.logger.debug('Quality evaluation skipped', {
          conversationId: data.conversationId,
          reason: String(error),
        });
      });
    });

    this.queue.register<{ conversationId: string; messageId?: string }>(
      QUEUES.intelligence,
      async (data) => {
        await this.intelligence.extract(data.conversationId).catch((error) => {
          this.logger.debug('Intelligence extraction skipped', {
            conversationId: data.conversationId,
            reason: String(error),
          });
        });
      },
    );

    this.queue.register<{ executionId: string }>(QUEUES.execution, async (data) => {
      await this.runtime.run(data.executionId);
    });

    this.logger.info('Worker tier started', { queues: Object.values(QUEUES).length });
  }

  // ── Scheduled work ─────────────────────────────────────────────────────────

  /** Relay committed outbox events. Frequent, cheap, and lock-guarded. */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async relayOutbox(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.outbox.drain();
    } catch (error) {
      this.logger.error('Outbox relay failed', error);
    }
  }

  /** Emit SLA warnings and breaches as their thresholds pass. */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepSla(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.sla.sweep();
    } catch (error) {
      this.logger.error('SLA sweep failed', error);
    }
  }

  /** Resume executions whose timers have elapsed. */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async resumeExecutions(): Promise<void> {
    if (!this.enabled) return;
    try {
      const resumed = await this.runtime.resumeDue();
      if (resumed) this.logger.debug('Resumed suspended executions', { resumed });
    } catch (error) {
      this.logger.error('Execution resumption failed', error);
    }
  }

  /** Publish queue depth so alerting can see a backlog forming. */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async reportQueueDepth(): Promise<void> {
    if (!this.enabled) return;
    for (const name of Object.values(QUEUES)) {
      try {
        const counts = await this.queue.counts(name);
        for (const [state, count] of Object.entries(counts)) {
          this.metrics.queueDepth.set({ queue: name, state }, Number(count ?? 0));
        }
      } catch {
        // A queue with no consumer yet simply has nothing to report.
      }
    }
  }

  /** Purge expired memory and stale idempotency keys. */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpired(): Promise<void> {
    if (!this.enabled) return;
    try {
      await RequestContextStore.runAsSystem(async () => {
        await this.memory.purgeExpired();
        const keys = await this.prisma.raw.idempotencyKey.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        if (keys.count) this.logger.debug('Purged expired idempotency keys', { count: keys.count });
      });
    } catch (error) {
      this.logger.error('Expiry purge failed', error);
    }
  }

  /**
   * Enforce each tenant's data retention policy. Deleting conversations
   * cascades to their messages, attachments, clocks and evaluations.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async enforceRetention(): Promise<void> {
    if (!this.enabled) return;

    const policies = await this.prisma.raw.governancePolicy.findMany({
      where: { dataRetentionDays: { gt: 0 } },
      select: { organizationId: true, dataRetentionDays: true },
    });

    for (const policy of policies) {
      const cutoff = new Date(Date.now() - policy.dataRetentionDays * 86_400_000);
      try {
        const removed = await this.prisma.raw.conversation.deleteMany({
          where: {
            organizationId: policy.organizationId,
            status: 'closed',
            closedAt: { lt: cutoff },
          },
        });
        if (removed.count) {
          this.logger.info('Applied data retention', {
            organizationId: policy.organizationId,
            removed: removed.count,
            retentionDays: policy.dataRetentionDays,
          });
        }
      } catch (error) {
        this.logger.error('Retention enforcement failed', error, {
          organizationId: policy.organizationId,
        });
      }
    }
  }

  /**
   * Send the reports whose schedule has come due.
   *
   * Hourly, so a report schedule is honoured to the hour. Finer than that would
   * mean a cron sweep competing with request traffic to deliver an email nobody
   * is waiting on to the minute.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async dispatchScheduledReports(): Promise<void> {
    if (!this.enabled) return;
    try {
      const sent = await this.reports.dispatchScheduled();
      if (sent) this.logger.info('Scheduled reports delivered', { count: sent });
    } catch (error) {
      this.logger.error('Scheduled report dispatch failed', error);
    }
  }

  /**
   * Compute yesterday's adherence for everyone who was rostered.
   *
   * Run in the small hours so the day is closed: computing it live would keep
   * rewriting a number that is still moving.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async computeAdherence(): Promise<void> {
    if (!this.enabled) return;

    const yesterday = new Date(Date.now() - 86_400_000);
    const organizations = await this.prisma.raw.organization.findMany({ select: { id: true } });

    for (const organization of organizations) {
      try {
        const agents = await RequestContextStore.runAsSystem(
          () => this.wfm.computeAdherenceForDay(yesterday),
          organization.id,
        );
        if (agents)
          this.logger.info('Adherence computed', { organizationId: organization.id, agents });
      } catch (error) {
        this.logger.error('Adherence computation failed', error, {
          organizationId: organization.id,
        });
      }
    }
  }

  /**
   * Hybrid deployment upkeep.
   *
   * A data plane reports in; a control plane notices the ones that stopped.
   * Both are no-ops in a standalone deployment, which is what SaaS and private
   * cloud run, so neither pays for this.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async hybridUpkeep(): Promise<void> {
    if (!this.enabled) return;

    const mode = this.hybrid.mode();
    if (mode === 'standalone') return;

    try {
      if (mode === 'data_plane') {
        const result = await this.hybrid.sendHeartbeat();
        if (!result.sent) this.logger.warn('Heartbeat not sent', { reason: result.reason });
      } else {
        await this.hybrid.sweepUnreachable();
      }
    } catch (error) {
      this.logger.error('Hybrid upkeep failed', error);
    }
  }

  /**
   * Nightly backup, then prove the last one restores.
   *
   * The verification is the point. Taking a backup every night and never
   * restoring one is how an organization discovers on the worst day of its
   * year that the archives were empty for four months.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async nightlyBackup(): Promise<void> {
    if (!this.enabled) return;

    try {
      const backup = await RequestContextStore.runAsSystem(() =>
        this.backups.create({ retentionDays: 30 }),
      );
      await RequestContextStore.runAsSystem(() => this.backups.verify(backup.id));
      const pruned = await RequestContextStore.runAsSystem(() => this.backups.prune());
      if (pruned) this.logger.info('Expired backups pruned', { count: pruned });
    } catch (error) {
      this.logger.error('The nightly backup failed', error);
    }
  }

  /**
   * Close yesterday: roll up analytics and record metered usage.
   *
   * Both are written rather than computed on demand because both have to
   * survive retention deleting the rows they counted — an invoice that cannot
   * be reproduced after a customer's conversations expire is not an invoice.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async dailyRollups(): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.metricsRollup.rollupYesterday();
    } catch (error) {
      this.logger.error('Metric rollup failed', error);
    }

    try {
      const tenants = await this.billing.rollupAllTenants();
      if (tenants) this.logger.info('Usage recorded', { tenants });
    } catch (error) {
      this.logger.error('Usage rollup failed', error);
    }
  }

  /** Pull contacts from every enabled integration. */
  @Cron(CronExpression.EVERY_6_HOURS)
  async syncIntegrations(): Promise<void> {
    if (!this.enabled) return;
    try {
      const synced = await this.integrations.syncDue();
      if (synced) this.logger.info('Integrations synchronized', { count: synced });
    } catch (error) {
      this.logger.error('Integration sync sweep failed', error);
    }
  }

  /** Crawl knowledge sources that declare a synchronization schedule. */
  @Cron(CronExpression.EVERY_6_HOURS)
  async syncKnowledgeSources(): Promise<void> {
    if (!this.enabled) return;

    const sources = await this.prisma.raw.knowledgeSource.findMany({
      where: { isActive: true, syncCron: { not: null }, type: { in: ['website', 'url'] } },
      select: { id: true, organizationId: true },
      take: 50,
    });

    for (const source of sources) {
      try {
        await RequestContextStore.runAsSystem(
          () => this.knowledge.syncSource(source.id),
          source.organizationId,
        );
      } catch (error) {
        this.logger.error('Knowledge source sync failed', error, { sourceId: source.id });
      }
    }
  }

  /**
   * Retry webhook deliveries whose backoff has elapsed.
   *
   * The sending itself lives in WebhooksService, which the request path also
   * goes through, so backoff, failure counting and auto-disable cannot drift
   * apart between the first attempt and the twelfth.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryWebhooks(): Promise<void> {
    if (!this.enabled) return;

    try {
      const delivered = await RequestContextStore.runAsSystem(() => this.webhooks.retryDue());
      if (delivered) this.logger.debug('Retried webhook deliveries', { delivered });
    } catch (error) {
      this.logger.error('Webhook retry sweep failed', error);
    }
  }

  /**
   * Keep monthly partitions ahead of the writes and behind retention.
   *
   * Daily rather than monthly, and creating two months ahead, because the
   * failure mode is total: a range-partitioned table with no partition for
   * today rejects every insert. A daily job that runs 28 times before it is
   * needed is the cheapest insurance in the platform.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async maintainPartitions(): Promise<void> {
    if (!this.enabled) return;
    try {
      const results = await RequestContextStore.runAsSystem(() => this.partitions.maintain());
      const changed = results.filter((row) => row.created.length || row.dropped.length);
      if (changed.length) this.logger.info('Partitions maintained', { changed });
    } catch (error) {
      this.logger.error('Partition maintenance failed', error);
    }
  }
}
