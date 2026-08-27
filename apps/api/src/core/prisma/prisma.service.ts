import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppLogger } from '../logger/logger.service';
import { tenantGuardExtension } from './tenant-guard.extension';

export type TenantPrisma = ReturnType<PrismaService['withGuard']>;

export interface ReplicaOptions {
  url?: string;
  /** Beyond this, a replica read is not worth taking. */
  maxLagSeconds?: number;
}

/**
 * Three views onto the database:
 *
 * - `db`      — tenant-guarded, primary. Everything that serves a request.
 * - `raw`     — unguarded, primary. Platform work that legitimately spans
 *               tenants (the outbox relay, retention sweeps) and raw SQL,
 *               which must scope itself.
 * - `replica` — tenant-guarded, read-only, possibly stale. Reporting and
 *               analytics only, through `readOnly()`.
 *
 * When no replica is configured all three are the same connection, so code
 * written against `readOnly()` is correct on a single-node deployment too.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly raw: PrismaClient;
  readonly db: TenantPrisma;

  /** Undefined when no replica is configured. */
  private readonly replicaClient?: PrismaClient;
  private readonly replicaDb?: TenantPrisma;
  private readonly maxLagSeconds: number;

  constructor(
    private readonly logger: AppLogger,
    databaseUrl?: string,
    replica: ReplicaOptions = {},
  ) {
    this.maxLagSeconds = replica.maxLagSeconds ?? 30;
    this.raw = new PrismaClient({
      datasources: databaseUrl ? { db: { url: databaseUrl } } : undefined,
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    (this.raw as any).$on('warn', (event: { message: string }) =>
      this.logger.warn('Database warning', { message: event.message }),
    );
    (this.raw as any).$on('error', (event: { message: string }) =>
      this.logger.error('Database error', undefined, { message: event.message }),
    );

    this.db = this.withGuard();

    if (replica.url && replica.url !== databaseUrl) {
      this.replicaClient = new PrismaClient({ datasources: { db: { url: replica.url } } });
      this.replicaDb = this.replicaClient.$extends(tenantGuardExtension);
    }
  }

  private withGuard() {
    return this.raw.$extends(tenantGuardExtension);
  }

  /**
   * A client for a query that may read slightly stale data.
   *
   * Returns the primary when no replica is configured, so a caller never has to
   * branch. Use it only where staleness is genuinely acceptable — a dashboard,
   * a report, an export. Never for a read that a write in the same request
   * depends on: replication lag is exactly long enough to return the row as it
   * was before the write the user just made.
   *
   * The tenant guard is applied to the replica too. A read-only connection is
   * not a reason to read another tenant's data.
   */
  readOnly(): TenantPrisma {
    return this.replicaDb ?? this.db;
  }

  /** Whether reads are actually going somewhere other than the primary. */
  get hasReplica(): boolean {
    return Boolean(this.replicaClient);
  }

  /**
   * How far the replica is behind, in seconds, or null when there is no replica.
   *
   * Reported so an operator can see it on the health endpoint rather than
   * inferring it from a dashboard that looks a little out of date.
   */
  async replicaLagSeconds(): Promise<number | null> {
    if (!this.replicaClient) return null;
    try {
      const rows = await this.replicaClient.$queryRawUnsafe<{ lag: number | null }[]>(
        // On a replica this is the delay behind the primary; on a promoted or
        // standalone node it is null, which is honest — there is no lag.
        `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS lag`,
      );
      const lag = rows[0]?.lag;
      return lag === null || lag === undefined ? 0 : Math.max(0, lag);
    } catch (error) {
      this.logger.warn('Could not read replica lag', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async onModuleInit(): Promise<void> {
    await this.raw.$connect();
    this.logger.info('Database connected');

    if (this.replicaClient) {
      // Connected here rather than lazily so a misconfigured replica fails at
      // boot, where somebody is watching, instead of on the first report.
      await this.replicaClient.$connect();
      const lag = await this.replicaLagSeconds();
      this.logger.info('Read replica connected', { lagSeconds: lag, maxLagSeconds: this.maxLagSeconds });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.raw.$disconnect();
    await this.replicaClient?.$disconnect().catch(() => undefined);
  }

  /** Liveness probe used by the health controller. */
  async ping(): Promise<boolean> {
    try {
      await this.raw.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
