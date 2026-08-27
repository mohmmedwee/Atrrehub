/**
 * Which tables are partitioned by month, and how long each keeps its data.
 *
 * Held as data so that "how long do we keep request logs" has one answer, in
 * one place, that the maintenance job and the documentation both read.
 *
 * Only append-only tables are here, and only ones nothing has a foreign key
 * to. Postgres will not let a partitioned table be the target of a foreign key
 * unless the key includes the partition column, so a table other rows point at
 * cannot be partitioned without changing every one of those relationships —
 * which is a schema change, not a maintenance decision.
 */
export interface PartitionedTable {
  table: string;
  /** The timestamp column the range is over. */
  column: string;
  /** Months of data kept before a partition is dropped. */
  retentionMonths: number;
  why: string;
}

export const PARTITIONED_TABLES: PartitionedTable[] = [
  {
    table: 'api_request_logs',
    column: 'created_at',
    retentionMonths: 3,
    why: 'Pure telemetry, the highest-volume table in the platform, and nothing references it.',
  },
];

/** How many months of partitions to create ahead of time. */
export const MONTHS_AHEAD = 2;

export interface PartitionSpec {
  name: string;
  from: string;
  to: string;
}

/** `api_request_logs_2026_03`, covering March. */
export function partitionFor(table: string, month: Date): PartitionSpec {
  const from = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const to = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  const suffix = `${from.getUTCFullYear()}_${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    name: `${table}_${suffix}`,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

/**
 * The partitions that should exist right now: this month, the months ahead, and
 * every month still inside the retention window.
 *
 * The past ones matter as much as the future ones. A gap anywhere in the range
 * is not a missing file — it is an insert that fails, because Postgres has
 * nowhere to put the row.
 */
export function requiredPartitions(
  definition: PartitionedTable,
  now: Date,
  monthsAhead = MONTHS_AHEAD,
): PartitionSpec[] {
  const specs: PartitionSpec[] = [];
  for (let offset = -definition.retentionMonths; offset <= monthsAhead; offset += 1) {
    specs.push(
      partitionFor(
        definition.table,
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)),
      ),
    );
  }
  return specs;
}

/**
 * Partitions old enough to drop.
 *
 * Compared by the partition's own upper bound rather than by its name, so a
 * table someone partitioned by hand with a different naming scheme is left
 * alone rather than being dropped on a string match.
 */
export function expiredPartitions(
  definition: PartitionedTable,
  existing: { name: string; upperBound: string }[],
  now: Date,
): string[] {
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - definition.retentionMonths, 1),
  );
  return existing
    .filter((partition) => {
      const upper = new Date(partition.upperBound);
      return Number.isFinite(upper.getTime()) && upper <= cutoff;
    })
    .map((partition) => partition.name);
}

/** Only ever a table this module named, and only ever the shape it generates. */
export function isManagedPartitionName(table: string, name: string): boolean {
  return new RegExp(`^${table}_\\d{4}_\\d{2}$`).test(name);
}
