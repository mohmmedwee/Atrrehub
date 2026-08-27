import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../../config/configuration';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { StorageService } from '../../core/storage/storage.service';

const run = promisify(execFile);

/**
 * Backup and disaster recovery.
 *
 * The runbook already said the right thing — "an untested backup is a
 * hypothesis" — and then left the testing to a quarterly calendar reminder.
 * This turns that sentence into a job: take the backup, restore it into a
 * scratch database, count what came back, record the answer. A backup whose
 * status is `completed` is a file; only `verified` means anything.
 *
 * `pg_dump` in custom format rather than a cloud snapshot API, because it is
 * the one mechanism available in every deployment this platform targets —
 * managed Postgres, a private cluster and an air-gapped install alike. A
 * managed provider's PITR is better where it exists and the runbook still
 * points at it; this is the floor, not the ceiling.
 */

const DUMP_TIMEOUT_MS = 30 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** Tables whose row counts are compared before and after a restore. */
const WITNESS_TABLES = [
  'organizations',
  'users',
  'memberships',
  'customers',
  'conversations',
  'messages',
  'tickets',
  'knowledge_bases',
  'articles',
  'chunks',
];

export interface VerificationCheck {
  name: string;
  expected: number | string;
  actual: number | string;
  passed: boolean;
}

@Injectable()
export class BackupService {
  constructor(
    private readonly config: ConfigService<AppConfig>,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly logger: AppLogger,
  ) {}

  private databaseUrl(): URL {
    const url = this.config.get('database', { infer: true })?.url;
    if (!url) throw AppError.internal('No database URL is configured');
    return new URL(url);
  }

  /** Environment for the postgres CLI tools, with the password never on argv. */
  private pgEnv(url: URL): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: url.pathname.replace(/^\//, ''),
    };
  }

  /**
   * The `pg_dump` to use for this server.
   *
   * `pg_dump` refuses outright when its own major version is older than the
   * server's — it cannot know about newer catalogue structures. On a developer
   * machine with Postgres 15 client tools against a Postgres 16 container that
   * is a hard failure, and as a nightly job it fails silently until somebody
   * needs a restore.
   *
   * A version-matched binary is preferred where the distribution installs one;
   * otherwise the mismatch is reported with both versions and the remedy,
   * rather than surfacing as "exited with code 1".
   */
  private async resolvePgDump(): Promise<string> {
    const serverMajor = await this.serverMajorVersion();
    if (serverMajor === null) return 'pg_dump';

    // Debian and Ubuntu keep every installed major here, which is where a
    // matching binary usually already exists.
    const versioned = `/usr/lib/postgresql/${serverMajor}/bin/pg_dump`;
    if (existsSync(versioned)) return versioned;

    const clientMajor = await this.clientMajorVersion('pg_dump');
    if (clientMajor !== null && clientMajor < serverMajor) {
      throw AppError.dependency(
        `pg_dump ${clientMajor} cannot dump a PostgreSQL ${serverMajor} server. ` +
          `Install the version ${serverMajor} client tools (postgresql-client-${serverMajor}), ` +
          `or point PATH at a pg_dump of at least version ${serverMajor}.`,
      );
    }
    return 'pg_dump';
  }

  /** Read from the live connection rather than the URL — Prisma is already there. */
  private async serverMajorVersion(): Promise<number | null> {
    try {
      const rows = await this.prisma.raw.$queryRawUnsafe<{ v: string }[]>(
        'SELECT current_setting($1) AS v',
        'server_version_num',
      );
      // 160004 → 16. Postgres numbers majors in the ten-thousands from 10 on.
      const numeric = Number(rows[0]?.v);
      return Number.isFinite(numeric) ? Math.floor(numeric / 10_000) : null;
    } catch {
      return null;
    }
  }

  private async clientMajorVersion(binary: string): Promise<number | null> {
    try {
      const { stdout } = await run(binary, ['--version'], { timeout: 5_000 });
      // "pg_dump (PostgreSQL) 16.4" — the first number is the major.
      const match = /(\d+)/.exec(stdout);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  // ── Taking a backup ────────────────────────────────────────────────────────

  /**
   * Dump the database and store it.
   *
   * Checksummed on the way out, so a file that rots in object storage is
   * detectable before somebody needs it rather than during the incident where
   * they do.
   */
  async create(options: { kind?: 'full' | 'schema_only'; retentionDays?: number } = {}) {
    const kind = options.kind ?? 'full';
    const url = this.databaseUrl();
    const id = newId('backup');
    const startedAt = Date.now();

    const migration = await this.currentMigration();
    const storageKey = `backups/${new Date().toISOString().slice(0, 10)}/${id}.dump`;

    await this.prisma.raw.backupRecord.create({
      data: { id, kind, storageKey, status: 'running', migrationName: migration },
    });

    const workdir = await mkdtemp(join(tmpdir(), 'atr-backup-'));
    const file = join(workdir, 'db.dump');

    try {
      const pgDump = await this.resolvePgDump();
      await run(
        pgDump,
        [
          '--format=custom',
          '--no-owner',
          '--no-privileges',
          ...(kind === 'schema_only' ? ['--schema-only'] : []),
          '--file',
          file,
        ],
        { env: this.pgEnv(url), timeout: DUMP_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      );

      const content = await readFile(file);
      const { size } = await stat(file);
      const checksum = createHash('sha256').update(content).digest('hex');

      await this.storage.putInternal(storageKey, content, 'application/octet-stream');

      const record = await this.prisma.raw.backupRecord.update({
        where: { id },
        data: {
          status: 'completed',
          sizeBytes: BigInt(size),
          checksum,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          expiresAt: options.retentionDays
            ? new Date(Date.now() + options.retentionDays * 86_400_000)
            : null,
        },
      });

      this.logger.info('Backup taken', { id, sizeBytes: size, durationMs: Date.now() - startedAt });
      return this.present(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.raw.backupRecord.update({
        where: { id },
        data: { status: 'failed', error: message.slice(0, 1000), finishedAt: new Date() },
      });
      throw AppError.internal(`The backup failed: ${message}`);
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── Proving it ─────────────────────────────────────────────────────────────

  /**
   * The drill. Restore the backup into a scratch database and check it.
   *
   * Restoring into a throwaway database rather than anywhere near production
   * is the whole point: a verification that could damage the thing it protects
   * would never be allowed to run often enough to be useful.
   *
   * The scratch database is dropped whatever happens, so a failed drill does
   * not leave a half-restored database for the next one to trip over.
   */
  async verify(backupId: string) {
    const record = await this.prisma.raw.backupRecord.findFirst({ where: { id: backupId } });
    if (!record) throw AppError.notFound('Backup', backupId);
    if (record.status === 'running') throw AppError.conflict('That backup is still being taken');

    const url = this.databaseUrl();
    const env = this.pgEnv(url);
    const scratch = `atr_verify_${Date.now().toString(36)}`;
    const workdir = await mkdtemp(join(tmpdir(), 'atr-verify-'));
    const file = join(workdir, 'db.dump');

    const checks: VerificationCheck[] = [];
    let created = false;

    try {
      const content = await this.storage.get(record.storageKey);

      // A corrupted archive is worth catching before the restore, because
      // pg_restore's error will not say "this file is not what we stored".
      if (record.checksum) {
        const actual = createHash('sha256').update(content).digest('hex');
        checks.push({
          name: 'archive checksum',
          expected: record.checksum,
          actual,
          passed: actual === record.checksum,
        });
        if (actual !== record.checksum)
          throw new Error('the stored archive does not match its checksum');
      }

      await writeFile(file, content);
      const before = await this.witnessCounts();

      await run('createdb', [scratch], { env, timeout: 60_000 });
      created = true;

      // pg_restore exits non-zero on benign notices (extensions already
      // present, ownership), so its exit code is not the verdict — the counts
      // are. The message is kept and surfaced only if the checks then fail.
      let restoreWarning: string | undefined;
      try {
        await run('pg_restore', ['--dbname', scratch, '--no-owner', '--no-privileges', file], {
          env,
          timeout: DUMP_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
        });
      } catch (error) {
        restoreWarning = error instanceof Error ? error.message.slice(0, 400) : String(error);
      }

      const after = await this.scratchCounts(env, scratch);
      for (const table of WITNESS_TABLES) {
        const expected = before[table] ?? 0;
        const actual = after[table] ?? -1;
        checks.push({
          name: `rows in ${table}`,
          expected,
          actual,
          // A restore may legitimately hold *more* rows than the live database
          // holds now, because rows can be deleted after a backup is taken.
          // Fewer is the failure.
          passed: actual >= expected,
        });
      }

      const tableCount = await this.scratchScalar(
        env,
        scratch,
        "select count(*) from information_schema.tables where table_schema='public'",
      );
      const liveTableCount = await this.scratchScalar(
        env,
        env.PGDATABASE!,
        "select count(*) from information_schema.tables where table_schema='public'",
      );
      checks.push({
        name: 'tables restored',
        expected: liveTableCount,
        actual: tableCount,
        passed: tableCount >= liveTableCount,
      });

      const migration = await this.scratchScalarText(
        env,
        scratch,
        'select migration_name from _prisma_migrations order by finished_at desc limit 1',
      );
      checks.push({
        name: 'schema version',
        expected: record.migrationName ?? '(unknown)',
        actual: migration ?? '(none)',
        passed: !record.migrationName || migration === record.migrationName,
      });

      const passed = checks.every((check) => check.passed);
      const updated = await this.prisma.raw.backupRecord.update({
        where: { id: backupId },
        data: {
          status: passed ? 'verified' : 'unrestorable',
          verifiedAt: new Date(),
          verification: {
            checks,
            tables: tableCount,
            rows: Object.values(after).reduce((sum, count) => sum + Math.max(0, count), 0),
            ...(restoreWarning ? { restoreWarning } : {}),
          } as unknown as Prisma.InputJsonValue,
          error: passed ? null : (restoreWarning ?? 'one or more checks failed'),
        },
      });

      if (passed) this.logger.info('Backup verified restorable', { backupId });
      else
        this.logger.error('Backup FAILED verification', undefined, {
          backupId,
          failed: checks.filter((check) => !check.passed),
        });

      return this.present(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = await this.prisma.raw.backupRecord.update({
        where: { id: backupId },
        data: {
          status: 'unrestorable',
          verifiedAt: new Date(),
          verification: { checks } as unknown as Prisma.InputJsonValue,
          error: message.slice(0, 1000),
        },
      });
      this.logger.error('Backup FAILED verification', error, { backupId });
      return this.present(updated);
    } finally {
      if (created)
        await run('dropdb', ['--if-exists', '--force', scratch], { env, timeout: 60_000 }).catch(
          (error) =>
            this.logger.error('Could not drop the verification database', error, { scratch }),
        );
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── Housekeeping ───────────────────────────────────────────────────────────

  async list(limit = 50) {
    const records = await this.prisma.raw.backupRecord.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(limit, 200),
    });
    return records.map((record) => this.present(record));
  }

  async get(backupId: string) {
    const record = await this.prisma.raw.backupRecord.findFirst({ where: { id: backupId } });
    if (!record) throw AppError.notFound('Backup', backupId);
    return this.present(record);
  }

  /**
   * Recovery readiness, as one answer.
   *
   * The question an auditor asks and an operator should be able to answer
   * without reading a table: is there a backup, is it recent, and has anyone
   * proved it works?
   */
  async readiness() {
    const [latest, latestVerified, unrestorable] = await Promise.all([
      this.prisma.raw.backupRecord.findFirst({
        where: { status: { in: ['completed', 'verified'] } },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.raw.backupRecord.findFirst({
        where: { status: 'verified' },
        orderBy: { verifiedAt: 'desc' },
      }),
      this.prisma.raw.backupRecord.count({ where: { status: 'unrestorable' } }),
    ]);

    const backupAgeHours = latest
      ? Math.round((Date.now() - latest.startedAt.getTime()) / 3_600_000)
      : null;
    const verifiedAgeHours = latestVerified?.verifiedAt
      ? Math.round((Date.now() - latestVerified.verifiedAt.getTime()) / 3_600_000)
      : null;

    return {
      hasBackup: Boolean(latest),
      latestBackupAt: latest?.startedAt ?? null,
      backupAgeHours,
      // The number that matters. A recent backup nobody has restored is not
      // recovery readiness, it is a file.
      hasVerifiedBackup: Boolean(latestVerified),
      latestVerifiedAt: latestVerified?.verifiedAt ?? null,
      verifiedAgeHours,
      unrestorableCount: unrestorable,
      ready: Boolean(latestVerified) && (verifiedAgeHours ?? Number.POSITIVE_INFINITY) < 24 * 8,
    };
  }

  /** Delete expired archives and forget them. */
  async prune(): Promise<number> {
    const expired = await this.prisma.raw.backupRecord.findMany({
      where: { expiresAt: { lt: new Date() } },
      select: { id: true, storageKey: true },
    });

    for (const record of expired) {
      await this.storage.delete(record.storageKey).catch(() => undefined);
      await this.prisma.raw.backupRecord.delete({ where: { id: record.id } });
    }
    return expired.length;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async currentMigration(): Promise<string | undefined> {
    const rows = await this.prisma.raw.$queryRawUnsafe<{ migration_name: string }[]>(
      'select migration_name from _prisma_migrations order by finished_at desc limit 1',
    );
    return rows[0]?.migration_name;
  }

  private async witnessCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of WITNESS_TABLES) {
      const rows = await this.prisma.raw.$queryRawUnsafe<{ count: bigint }[]>(
        `select count(*) as count from "${table}"`,
      );
      counts[table] = Number(rows[0]?.count ?? 0);
    }
    return counts;
  }

  private async scratchCounts(
    env: NodeJS.ProcessEnv,
    database: string,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of WITNESS_TABLES) {
      counts[table] = await this.scratchScalar(env, database, `select count(*) from "${table}"`);
    }
    return counts;
  }

  private async scratchScalar(
    env: NodeJS.ProcessEnv,
    database: string,
    sql: string,
  ): Promise<number> {
    const text = await this.scratchScalarText(env, database, sql);
    return text === null ? -1 : Number(text);
  }

  private async scratchScalarText(
    env: NodeJS.ProcessEnv,
    database: string,
    sql: string,
  ): Promise<string | null> {
    try {
      const { stdout } = await run('psql', ['--dbname', database, '-tAc', sql], {
        env,
        timeout: 60_000,
        maxBuffer: MAX_BUFFER,
      });
      const value = stdout.trim();
      return value.length ? value : null;
    } catch {
      return null;
    }
  }

  /** BigInt does not survive JSON, so size is presented as a number. */
  private present<T extends { sizeBytes: bigint }>(record: T) {
    return { ...record, sizeBytes: Number(record.sizeBytes) };
  }
}
