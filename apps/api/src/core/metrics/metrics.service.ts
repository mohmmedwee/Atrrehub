import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus instrumentation for the metrics named in the observability plan:
 * API latency, error rate, queue depth, worker utilization, database latency,
 * AI latency, workflow failures and search latency.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'atrrehub_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.3, 0.6, 1, 2.5, 5, 10],
  });

  readonly httpErrors = new Counter({
    name: 'atrrehub_http_errors_total',
    help: 'HTTP responses with a 4xx or 5xx status',
    labelNames: ['method', 'route', 'status', 'code'] as const,
  });

  readonly dbDuration = new Histogram({
    name: 'atrrehub_db_query_duration_seconds',
    help: 'Database query duration in seconds',
    labelNames: ['model', 'operation'] as const,
    buckets: [0.001, 0.005, 0.02, 0.05, 0.15, 0.4, 1, 3],
  });

  readonly aiDuration = new Histogram({
    name: 'atrrehub_ai_request_duration_seconds',
    help: 'AI provider request duration in seconds',
    labelNames: ['provider', 'model', 'operation'] as const,
    buckets: [0.1, 0.3, 0.8, 1.5, 3, 6, 12, 30, 60],
  });

  readonly aiTokens = new Counter({
    name: 'atrrehub_ai_tokens_total',
    help: 'Tokens consumed by AI requests',
    labelNames: ['provider', 'model', 'kind'] as const,
  });

  readonly aiCost = new Counter({
    name: 'atrrehub_ai_cost_usd_total',
    help: 'Estimated AI spend in USD',
    labelNames: ['provider', 'model'] as const,
  });

  readonly retrievalDuration = new Histogram({
    name: 'atrrehub_retrieval_duration_seconds',
    help: 'RAG retrieval duration in seconds',
    labelNames: ['stage'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  });

  /**
   * Speech latency, bucketed far tighter than the AI histogram: on a live call
   * the interesting question is whether a turn came back under half a second,
   * and the AI buckets cannot see the difference between 200 ms and 700 ms.
   */
  readonly speechDuration = new Histogram({
    name: 'atrrehub_speech_duration_seconds',
    help: 'Speech recognition and synthesis duration in seconds',
    labelNames: ['kind', 'provider'] as const,
    buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2, 4, 8],
  });

  /** End-to-end latency of one AI voice turn: caller stopped speaking → reply begins. */
  readonly voiceTurnDuration = new Histogram({
    name: 'atrrehub_voice_turn_duration_seconds',
    help: 'AI voice agent turn latency in seconds',
    labelNames: ['outcome'] as const,
    buckets: [0.25, 0.5, 0.8, 1.2, 1.8, 2.5, 4, 8],
  });

  readonly callsTotal = new Counter({
    name: 'atrrehub_calls_total',
    help: 'Calls by direction and disposition',
    labelNames: ['direction', 'disposition'] as const,
  });

  readonly queueDepth = new Gauge({
    name: 'atrrehub_queue_depth',
    help: 'Jobs waiting in each queue',
    labelNames: ['queue', 'state'] as const,
  });

  readonly workflowFailures = new Counter({
    name: 'atrrehub_workflow_failures_total',
    help: 'Workflow executions that terminated in failure',
    labelNames: ['workflow', 'node_type'] as const,
  });

  readonly deadLetters = new Counter({
    name: 'atrrehub_dead_letters_total',
    help: 'Jobs that exhausted every retry and were dead-lettered',
    labelNames: ['queue'] as const,
  });

  readonly conversationsOpen = new Gauge({
    name: 'atrrehub_conversations_open',
    help: 'Conversations currently open, by status',
    labelNames: ['status'] as const,
  });

  readonly slaBreaches = new Counter({
    name: 'atrrehub_sla_breaches_total',
    help: 'SLA targets breached',
    labelNames: ['target_type', 'priority'] as const,
  });

  readonly guardrailBlocks = new Counter({
    name: 'atrrehub_guardrail_blocks_total',
    help: 'Guardrail decisions that blocked or diverted a request',
    labelNames: ['stage', 'check', 'action'] as const,
  });

  constructor(enableDefaults = true) {
    if (enableDefaults) collectDefaultMetrics({ register: this.registry, prefix: 'atrrehub_' });
    for (const metric of [
      this.httpDuration,
      this.httpErrors,
      this.dbDuration,
      this.aiDuration,
      this.aiTokens,
      this.aiCost,
      this.retrievalDuration,
      this.queueDepth,
      this.deadLetters,
      this.workflowFailures,
      this.conversationsOpen,
      this.slaBreaches,
      this.guardrailBlocks,
    ]) {
      this.registry.registerMetric(metric as never);
    }
  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
