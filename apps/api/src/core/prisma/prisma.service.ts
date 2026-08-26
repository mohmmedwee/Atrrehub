import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppLogger } from '../logger/logger.service';
import { tenantGuardExtension } from './tenant-guard.extension';

export type TenantPrisma = ReturnType<PrismaService['withGuard']>;

/**
 * Two views onto one connection pool:
 *
 * - `db`  — tenant-guarded. Everything that serves a request uses this.
 * - `raw` — unguarded. Reserved for platform work that legitimately spans
 *           tenants (the outbox relay, retention sweeps, migrations) and for
 *           raw SQL, which must scope itself.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly raw: PrismaClient;
  readonly db: TenantPrisma;

  constructor(
    private readonly logger: AppLogger,
    databaseUrl?: string,
  ) {
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
  }

  private withGuard() {
    return this.raw.$extends(tenantGuardExtension);
  }

  async onModuleInit(): Promise<void> {
    await this.raw.$connect();
    this.logger.info('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.raw.$disconnect();
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
