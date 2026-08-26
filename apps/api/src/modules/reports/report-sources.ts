/**
 * The report catalogue.
 *
 * Reporting is a query builder pointed at production data by whoever can save a
 * report, so it is deliberately closed: a report names a source, and every
 * metric, dimension and filter it can use is declared here against a real
 * column. Nothing a caller sends reaches SQL as an identifier — only as a bound
 * parameter — so a saved report cannot become a way to read another table, or
 * another tenant's rows.
 */

export type FilterKind = 'string' | 'enum' | 'boolean' | 'number';

export interface DimensionSpec {
  label: string;
  /** SQL expression, built only from identifiers declared in this file. */
  sql: string;
}

export interface MetricSpec {
  label: string;
  sql: string;
  /** Rounded to this many decimals on the way out. Integers use 0. */
  precision: number;
}

export interface FilterSpec {
  label: string;
  column: string;
  kind: FilterKind;
  values?: readonly string[];
}

export interface ReportSource {
  label: string;
  description: string;
  table: string;
  alias: string;
  /** The column a report's date range applies to. */
  dateColumn: string;
  dimensions: Record<string, DimensionSpec>;
  metrics: Record<string, MetricSpec>;
  filters: Record<string, FilterSpec>;
}

/** Truncation buckets shared by every source, applied to its own date column. */
export const DATE_BUCKETS = ['day', 'week', 'month'] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];

const CHANNELS = [
  'web_chat',
  'email',
  'voice',
  'whatsapp',
  'sms',
  'telegram',
  'messenger',
  'instagram',
  'teams',
  'api',
] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const REPORT_SOURCES: Record<string, ReportSource> = {
  conversations: {
    label: 'Conversations',
    description: 'Volume, resolution and handling time across channels and queues',
    table: 'conversations',
    alias: 'c',
    dateColumn: 'created_at',
    dimensions: {
      channel: { label: 'Channel', sql: 'c.channel::text' },
      status: { label: 'Status', sql: 'c.status::text' },
      priority: { label: 'Priority', sql: 'c.priority::text' },
      queue: { label: 'Queue', sql: "COALESCE(c.queue_id, 'unassigned')" },
      assignee: { label: 'Assignee', sql: "COALESCE(c.assignee_id, 'unassigned')" },
      locale: { label: 'Language', sql: 'c.locale' },
      aiHandled: { label: 'Handled by AI', sql: 'c.ai_handled::text' },
    },
    metrics: {
      count: { label: 'Conversations', sql: 'COUNT(*)', precision: 0 },
      resolved: {
        label: 'Resolved',
        sql: 'COUNT(*) FILTER (WHERE c.resolved_at IS NOT NULL)',
        precision: 0,
      },
      aiResolved: {
        label: 'Resolved by AI',
        sql: 'COUNT(*) FILTER (WHERE c.resolved_at IS NOT NULL AND c.ai_handled)',
        precision: 0,
      },
      handedOff: {
        label: 'Handed off',
        sql: 'COUNT(*) FILTER (WHERE c.handoff_reason IS NOT NULL)',
        precision: 0,
      },
      avgFirstResponseMinutes: {
        label: 'Avg first response (min)',
        sql: 'AVG(EXTRACT(EPOCH FROM (c.first_response_at - c.created_at)) / 60)',
        precision: 1,
      },
      avgResolutionHours: {
        label: 'Avg resolution (hrs)',
        sql: 'AVG(EXTRACT(EPOCH FROM (c.resolved_at - c.created_at)) / 3600)',
        precision: 2,
      },
      avgMessages: { label: 'Avg messages', sql: 'AVG(c.message_count)', precision: 1 },
      avgCsat: { label: 'Avg CSAT', sql: 'AVG(c.csat_score)', precision: 2 },
    },
    filters: {
      channel: { label: 'Channel', column: 'c.channel', kind: 'enum', values: CHANNELS },
      status: { label: 'Status', column: 'c.status', kind: 'enum' },
      priority: { label: 'Priority', column: 'c.priority', kind: 'enum', values: PRIORITIES },
      queueId: { label: 'Queue', column: 'c.queue_id', kind: 'string' },
      teamId: { label: 'Team', column: 'c.team_id', kind: 'string' },
      assigneeId: { label: 'Assignee', column: 'c.assignee_id', kind: 'string' },
      locale: { label: 'Language', column: 'c.locale', kind: 'string' },
      aiHandled: { label: 'Handled by AI', column: 'c.ai_handled', kind: 'boolean' },
    },
  },

  tickets: {
    label: 'Tickets',
    description: 'Case volume, backlog and resolution time',
    table: 'tickets',
    alias: 't',
    dateColumn: 'created_at',
    dimensions: {
      status: { label: 'Status', sql: 't.status::text' },
      priority: { label: 'Priority', sql: 't.priority::text' },
      category: { label: 'Category', sql: "COALESCE(t.category, 'uncategorised')" },
      source: { label: 'Source', sql: 't.source::text' },
      queue: { label: 'Queue', sql: "COALESCE(t.queue_id, 'unassigned')" },
      assignee: { label: 'Assignee', sql: "COALESCE(t.assignee_id, 'unassigned')" },
    },
    metrics: {
      count: { label: 'Tickets', sql: 'COUNT(*)', precision: 0 },
      resolved: {
        label: 'Resolved',
        sql: 'COUNT(*) FILTER (WHERE t.resolved_at IS NOT NULL)',
        precision: 0,
      },
      reopened: { label: 'Reopened', sql: 'SUM(t.reopen_count)', precision: 0 },
      overdue: {
        label: 'Past due',
        sql: 'COUNT(*) FILTER (WHERE t.due_at < NOW() AND t.resolved_at IS NULL)',
        precision: 0,
      },
      avgResolutionHours: {
        label: 'Avg resolution (hrs)',
        sql: 'AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600)',
        precision: 2,
      },
    },
    filters: {
      status: { label: 'Status', column: 't.status', kind: 'enum' },
      priority: { label: 'Priority', column: 't.priority', kind: 'enum', values: PRIORITIES },
      category: { label: 'Category', column: 't.category', kind: 'string' },
      queueId: { label: 'Queue', column: 't.queue_id', kind: 'string' },
      teamId: { label: 'Team', column: 't.team_id', kind: 'string' },
      assigneeId: { label: 'Assignee', column: 't.assignee_id', kind: 'string' },
    },
  },

  sla: {
    label: 'SLA',
    description: 'Attainment and breaches by policy and target',
    table: 'sla_clocks',
    alias: 's',
    dateColumn: 'started_at',
    dimensions: {
      policy: { label: 'Policy', sql: 's.policy_id' },
      target: { label: 'Target', sql: 's.type::text' },
      state: { label: 'State', sql: 's.state::text' },
    },
    metrics: {
      count: { label: 'Clocks', sql: 'COUNT(*)', precision: 0 },
      met: {
        label: 'Met',
        sql: "COUNT(*) FILTER (WHERE s.state = 'met')",
        precision: 0,
      },
      breached: {
        label: 'Breached',
        sql: 'COUNT(*) FILTER (WHERE s.breached_at IS NOT NULL)',
        precision: 0,
      },
      attainment: {
        label: 'Attainment %',
        sql: `100.0 * COUNT(*) FILTER (WHERE s.breached_at IS NULL AND s.completed_at IS NOT NULL)
              / NULLIF(COUNT(*) FILTER (WHERE s.completed_at IS NOT NULL), 0)`,
        precision: 1,
      },
      avgElapsedMinutes: {
        label: 'Avg elapsed (min)',
        sql: 'AVG(s.elapsed_ms) / 60000.0',
        precision: 1,
      },
    },
    filters: {
      policyId: { label: 'Policy', column: 's.policy_id', kind: 'string' },
      type: { label: 'Target', column: 's.type', kind: 'enum' },
      state: { label: 'State', column: 's.state', kind: 'enum' },
    },
  },

  ai: {
    label: 'AI executions',
    description: 'Agent runs, outcomes, latency and cost',
    table: 'executions',
    alias: 'e',
    dateColumn: 'created_at',
    dimensions: {
      agent: { label: 'Agent', sql: "COALESCE(e.agent_id, 'none')" },
      status: { label: 'Status', sql: 'e.status::text' },
      trigger: { label: 'Trigger', sql: 'e.trigger_type' },
    },
    metrics: {
      count: { label: 'Executions', sql: 'COUNT(*)', precision: 0 },
      succeeded: {
        label: 'Succeeded',
        sql: "COUNT(*) FILTER (WHERE e.status = 'succeeded')",
        precision: 0,
      },
      failed: { label: 'Failed', sql: "COUNT(*) FILTER (WHERE e.status = 'failed')", precision: 0 },
      avgDurationMs: { label: 'Avg duration (ms)', sql: 'AVG(e.duration_ms)', precision: 0 },
      totalCostUsd: { label: 'Cost (USD)', sql: 'SUM(e.cost_usd)', precision: 4 },
      totalTokens: {
        label: 'Tokens',
        sql: 'SUM(e.prompt_tokens + e.completion_tokens)',
        precision: 0,
      },
    },
    filters: {
      agentId: { label: 'Agent', column: 'e.agent_id', kind: 'string' },
      status: { label: 'Status', column: 'e.status', kind: 'enum' },
      triggerType: { label: 'Trigger', column: 'e.trigger_type', kind: 'string' },
    },
  },
};

export type ReportSourceKey = keyof typeof REPORT_SOURCES;

/** The catalogue as an API response: what a report builder can offer. */
export function describeSources() {
  return Object.entries(REPORT_SOURCES).map(([key, source]) => ({
    key,
    label: source.label,
    description: source.description,
    dateBuckets: DATE_BUCKETS,
    // Only the key and label: the SQL expression behind a dimension is an
    // implementation detail, and publishing it invites callers to send their own.
    dimensions: Object.entries(source.dimensions).map(([id, spec]) => ({
      key: id,
      label: spec.label,
    })),
    metrics: Object.entries(source.metrics).map(([id, spec]) => ({
      key: id,
      label: spec.label,
    })),
    filters: Object.entries(source.filters).map(([id, spec]) => ({
      key: id,
      label: spec.label,
      kind: spec.kind,
      values: spec.values,
    })),
  }));
}
