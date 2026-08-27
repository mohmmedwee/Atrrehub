import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import {
  PARTITIONED_TABLES,
  expiredPartitions,
  isManagedPartitionName,
  requiredPartitions,
  type PartitionedTable,
} from './partitions';

export interface PartitionMaintenanceResult {
  table: string;
  partitioned: boolean;
  created: string[];
  dropped: string[];
}

/**
 * Keeps monthly partitions ahead of the writes and behind the retention window.
 *
 * The failure this exists to prevent is specific and total: a range-partitioned
 * table with no partition for today rejects every insert. Partitions are
 * therefore created two months ahead, so a missed run is a warning rather than
 * an outage at midnight on the first of the month.
 *
 * Every statement here names a table from `PARTITIONED_TABLES` and a partition
 * name this module generated. Nothing from a request reaches it.
 */
@Injectable()
export class PartitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  async maintain(now = new Date()): Promise<PartitionMaintenanceResult[]> {
    const results: PartitionMaintenanceResult[] = [];
    for (const definition of PARTITIONED_TABLES) {
      results.push(await this.maintainTable(definition, now));
    }
    return results;
  }

  private async maintainTable(
    definition: PartitionedTable,
    now: Date,
  ): Promise<PartitionMaintenanceResult> {
    const result: PartitionMaintenanceResult = {
      table: definition.table,
      partitioned: await this.isPartitioned(definition.table),
      created: [],
      dropped: [],
    };

    // A deployment that has not run the conversion script yet still has an
    // ordinary table, and that is a supported state — the job does nothing
    // rather than failing every night until somebody converts it.
    if (!result.partitioned) return result;

    const existing = await this.existingPartitions(definition.table);
    const existingNames = new Set(existing.map((partition) => partition.name));

    for (const spec of requiredPartitions(definition, now)) {
      if (existingNames.has(spec.name)) continue;
      await this.prisma.raw.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${spec.name}" PARTITION OF "${definition.table}"
         FOR VALUES FROM ('${spec.from}') TO ('${spec.to}')`,
      );
      result.created.push(spec.name);
    }

    for (const name of expiredPartitions(definition, existing, now)) {
      // Belt and braces: `expiredPartitions` already works from the catalogue's
      // own bounds, but dropping a table is the one operation where a second
      // check on the name costs nothing and a mistake costs everything.
      if (!isManagedPartitionName(definition.table, name)) {
        this.logger.warn('Leaving an unmanaged partition alone', {
          table: definition.table,
          partition: name,
        });
        continue;
      }
      // Detached first so the drop cannot take a lock on the parent while
      // requests are writing to it.
      await this.prisma.raw.$executeRawUnsafe(
        `ALTER TABLE "${definition.table}" DETACH PARTITION "${name}"`,
      );
      await this.prisma.raw.$executeRawUnsafe(`DROP TABLE "${name}"`);
      result.dropped.push(name);
    }

    if (result.created.length || result.dropped.length) {
      this.logger.info('Partition maintenance', {
        table: definition.table,
        created: result.created,
        dropped: result.dropped,
      });
    }
    return result;
  }

  /** What exists today, for an operator and for the health of the job itself. */
  async describe() {
    const tables = [];
    for (const definition of PARTITIONED_TABLES) {
      const partitioned = await this.isPartitioned(definition.table);
      tables.push({
        table: definition.table,
        partitioned,
        retentionMonths: definition.retentionMonths,
        why: definition.why,
        partitions: partitioned ? await this.existingPartitions(definition.table) : [],
      });
    }
    return tables;
  }

  private async isPartitioned(table: string): Promise<boolean> {
    const rows = await this.prisma.raw.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) FROM pg_partitioned_table p
       JOIN pg_class c ON c.oid = p.partrelid
       WHERE c.relname = $1`,
      table,
    );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  /**
   * Existing partitions with their real upper bounds, read from the catalogue
   * rather than parsed out of their names — a partition attached by hand with
   * different bounds must not be dropped because its name looked right.
   */
  private async existingPartitions(
    table: string,
  ): Promise<{ name: string; upperBound: string }[]> {
    const rows = await this.prisma.raw.$queryRawUnsafe<{ name: string; expression: string }[]>(
      `SELECT child.relname AS name, pg_get_expr(child.relpartbound, child.oid) AS expression
       FROM pg_inherits
       JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
       JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
       WHERE parent.relname = $1
       ORDER BY child.relname`,
      table,
    );

    return rows.map((row) => ({
      name: row.name,
      // `FOR VALUES FROM ('2026-03-01') TO ('2026-04-01')` — the second literal.
      upperBound: row.expression?.match(/TO \('([^']+)'\)/)?.[1] ?? '',
    }));
  }
}
