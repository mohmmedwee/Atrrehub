import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type AiProvider, type ModelRole } from '@prisma/client';
import type { AppConfig } from '../../config/configuration';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { MetricsService } from '../../core/metrics/metrics.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { LocalProvider } from './providers/local.provider';
import { OpenAiProvider } from './providers/openai.provider';
import {
  estimateCostUsd,
  type AiProviderAdapter,
  type CompletionRequest,
  type CompletionResponse,
  type EmbeddingResponse,
} from './provider';

/** Model defaults per role when a tenant has not configured its own routes. */
const DEFAULT_MODELS: Record<ModelRole, Partial<Record<AiProvider, string>>> = {
  chat: { openai: 'gpt-4o', anthropic: 'claude-sonnet-4-5', azure_openai: 'gpt-4o', gemini: 'gemini-2.0-flash', local: 'local' },
  fast: { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-4-5', azure_openai: 'gpt-4o-mini', gemini: 'gemini-2.0-flash', local: 'local' },
  reasoning: { openai: 'gpt-4o', anthropic: 'claude-sonnet-4-5', azure_openai: 'gpt-4o', gemini: 'gemini-2.0-flash', local: 'local' },
  embedding: { openai: 'text-embedding-3-small', azure_openai: 'text-embedding-3-small', local: 'local' },
  rerank: { local: 'local' },
};

const MAX_ATTEMPTS = 3;

export interface GatewayCallOptions {
  role?: ModelRole;
  modelOverride?: string;
  operation?: string;
  agentId?: string;
  executionId?: string;
  conversationId?: string;
  /** Cache identical prompts for this many seconds. */
  cacheSeconds?: number;
}

/**
 * The only component that talks to an AI provider.
 *
 * Callers name a *role* (`chat`, `fast`, `reasoning`, `embedding`, `rerank`),
 * never a provider, so a tenant can change models without touching an agent.
 * The gateway owns selection, fallback, retry, token and cost accounting, and
 * enforcement of the tenant's governance limits.
 */
@Injectable()
export class AiGateway implements OnModuleInit {
  private readonly providers = new Map<AiProvider, AiProviderAdapter>();

  constructor(
    private readonly config: ConfigService<AppConfig>,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventBus,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    const ai = this.config.get('ai', { infer: true })!;

    // The local provider is always present, so the platform never hard-fails
    // for want of an API key.
    this.providers.set('local', new LocalProvider());

    const openai = new OpenAiProvider({ apiKey: ai.openai.apiKey, baseUrl: ai.openai.baseUrl });
    if (openai.isConfigured()) this.providers.set('openai', openai);

    const azure = new OpenAiProvider(
      { apiKey: ai.azure.apiKey, baseUrl: ai.openai.baseUrl, azure: { endpoint: ai.azure.endpoint, apiVersion: ai.azure.apiVersion } },
      true,
    );
    if (azure.isConfigured()) this.providers.set('azure_openai', azure);

    const anthropic = new AnthropicProvider({ apiKey: ai.anthropic.apiKey, baseUrl: ai.anthropic.baseUrl });
    if (anthropic.isConfigured()) this.providers.set('anthropic', anthropic);

    this.logger.info('AI gateway ready', { providers: [...this.providers.keys()] });
  }

  configuredProviders(): AiProvider[] {
    return [...this.providers.keys()];
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  /**
   * Resolve a role to an ordered chain of provider/model pairs: the tenant's
   * configured route first, then its declared fallbacks, then whatever is
   * actually configured, and finally the local provider so a call can always
   * be served.
   */
  private async chain(role: ModelRole, override?: string): Promise<{ provider: AiProvider; model: string }[]> {
    const organizationId = RequestContextStore.organizationId();
    const chain: { provider: AiProvider; model: string }[] = [];

    if (organizationId) {
      const route = await this.prisma.raw.modelRoute.findFirst({
        where: { organizationId, role, isActive: true },
      });
      if (route) {
        chain.push({ provider: route.provider, model: override ?? route.model });
        for (const fallback of (route.fallbacks ?? []) as { provider: AiProvider; model: string }[]) {
          chain.push(fallback);
        }
      }
    }

    const preferred = this.config.get('ai', { infer: true })!.defaultProvider as AiProvider;
    for (const provider of [preferred, ...this.providers.keys()]) {
      const model = override && provider === preferred ? override : DEFAULT_MODELS[role]?.[provider];
      if (model && !chain.some((entry) => entry.provider === provider)) {
        chain.push({ provider, model });
      }
    }

    if (!chain.some((entry) => entry.provider === 'local')) {
      chain.push({ provider: 'local', model: 'local' });
    }
    return chain.filter((entry) => this.providers.has(entry.provider));
  }

  // ── Completions ────────────────────────────────────────────────────────────

  async complete(
    request: Omit<CompletionRequest, 'model'> & { model?: string },
    options: GatewayCallOptions = {},
  ): Promise<CompletionResponse> {
    const role = options.role ?? 'chat';
    await this.assertWithinBudget();

    const cacheKey = options.cacheSeconds ? await this.cacheKey(role, request) : null;
    if (cacheKey) {
      const cached = await this.redis.get<CompletionResponse>(cacheKey);
      if (cached) {
        await this.recordUsage({ ...options, role }, cached, 0, true);
        return cached;
      }
    }

    const chain = await this.chain(role, options.modelOverride ?? request.model);
    let lastError: unknown;

    for (const [index, entry] of chain.entries()) {
      const adapter = this.providers.get(entry.provider)!;
      const started = Date.now();

      try {
        const response = await this.withRetry(() => adapter.complete({ ...request, model: entry.model }));
        const latencyMs = Date.now() - started;

        this.metrics.aiDuration.observe({ provider: entry.provider, model: entry.model, operation: 'complete' }, latencyMs / 1000);
        await this.recordUsage({ ...options, role, provider: entry.provider }, response, latencyMs, false);

        if (index > 0) {
          this.logger.warn('AI request served by a fallback provider', {
            role,
            provider: entry.provider,
            skipped: index,
          });
        }
        return response;
      } catch (error) {
        lastError = error;
        this.logger.warn('AI provider call failed, trying the next in the chain', {
          provider: entry.provider,
          model: entry.model,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw AppError.dependency('Every configured AI provider failed', lastError);
  }

  /** Completion constrained to a JSON schema, parsed and returned as an object. */
  async completeStructured<T>(
    request: Omit<CompletionRequest, 'model'> & { model?: string; responseSchema: Record<string, unknown> },
    options: GatewayCallOptions = {},
  ): Promise<{ value: T; response: CompletionResponse }> {
    const response = await this.complete(request, options);
    try {
      // Models sometimes wrap JSON in prose or a fenced block.
      const text = response.content.trim();
      const json = text.startsWith('{') || text.startsWith('[') ? text : (/\{[\s\S]*\}|\[[\s\S]*\]/.exec(text)?.[0] ?? text);
      return { value: JSON.parse(json) as T, response };
    } catch {
      throw AppError.dependency('The model did not return valid JSON for the requested schema');
    }
  }

  async *stream(
    request: Omit<CompletionRequest, 'model'> & { model?: string },
    options: GatewayCallOptions = {},
  ): AsyncGenerator<{ delta: string; done: boolean; usage?: CompletionResponse['usage'] }> {
    const role = options.role ?? 'chat';
    await this.assertWithinBudget();

    const chain = await this.chain(role, options.modelOverride ?? request.model);
    for (const entry of chain) {
      const adapter = this.providers.get(entry.provider)!;
      if (!adapter.stream) continue;
      const started = Date.now();
      try {
        for await (const chunk of adapter.stream({ ...request, model: entry.model })) {
          if (chunk.usage) {
            await this.recordUsage(
              { ...options, role, provider: entry.provider },
              { usage: chunk.usage, model: entry.model },
              Date.now() - started,
              false,
            );
          }
          yield chunk;
        }
        return;
      } catch (error) {
        this.logger.warn('Streaming provider failed, trying the next', { provider: entry.provider, error: String(error) });
      }
    }
    throw AppError.dependency('No AI provider could serve a streaming completion');
  }

  // ── Embeddings and reranking ───────────────────────────────────────────────

  async embed(input: string[], options: GatewayCallOptions = {}): Promise<EmbeddingResponse> {
    if (!input.length) return { embeddings: [], model: 'none', usage: { promptTokens: 0, totalTokens: 0 } };
    await this.assertWithinBudget();

    const dimensions = this.config.get('ai', { infer: true })!.embeddingDimensions;
    const chain = await this.chain('embedding', options.modelOverride);
    let lastError: unknown;

    for (const entry of chain) {
      const adapter = this.providers.get(entry.provider)!;
      const started = Date.now();
      try {
        const response = await this.withRetry(() =>
          adapter.embed({ input, model: entry.model, dimensions }),
        );
        // A vector of the wrong width cannot be written to the pgvector column.
        if (response.embeddings.some((vector) => vector.length !== dimensions)) {
          throw AppError.dependency(
            `${entry.provider} returned ${response.embeddings[0]?.length}-dimension vectors; the index expects ${dimensions}`,
          );
        }
        const latencyMs = Date.now() - started;
        this.metrics.aiDuration.observe({ provider: entry.provider, model: entry.model, operation: 'embed' }, latencyMs / 1000);
        await this.recordUsage(
          { ...options, role: 'embedding', provider: entry.provider, operation: 'embed' },
          { usage: { ...response.usage, completionTokens: 0 }, model: response.model },
          latencyMs,
          false,
        );
        return response;
      } catch (error) {
        lastError = error;
        this.logger.warn('Embedding provider failed, trying the next', { provider: entry.provider, error: String(error) });
      }
    }
    throw AppError.dependency('Every embedding provider failed', lastError);
  }

  async rerank(query: string, documents: string[], topN?: number): Promise<{ index: number; score: number }[]> {
    const chain = await this.chain('rerank');
    for (const entry of chain) {
      const adapter = this.providers.get(entry.provider);
      if (!adapter?.rerank) continue;
      try {
        const response = await adapter.rerank({ query, documents, model: entry.model, topN });
        return response.results;
      } catch (error) {
        this.logger.warn('Rerank provider failed', { provider: entry.provider, error: String(error) });
      }
    }
    // Preserve the incoming order rather than failing the whole retrieval.
    return documents.map((_, index) => ({ index, score: 0 }));
  }

  // ── Reliability ────────────────────────────────────────────────────────────

  /** Retry only what is worth retrying, with jittered exponential backoff. */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const retryable = error instanceof AppError && error.meta?.retryable === true;
        if (!retryable || attempt === MAX_ATTEMPTS) throw error;
        const backoff = 250 * 2 ** (attempt - 1) + Math.random() * 250;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw lastError;
  }

  // ── Governance and accounting ──────────────────────────────────────────────

  /**
   * Refuse a call that would exceed the tenant's monthly token or cost ceiling.
   * The running total is cached because this runs before every AI call.
   */
  private async assertWithinBudget(): Promise<void> {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return;

    const policy = await this.redis.remember(
      this.redis.key(organizationId, 'governance'),
      300,
      async () => this.prisma.raw.governancePolicy.findUnique({ where: { organizationId } }),
    );
    if (!policy?.monthlyTokenLimit && !policy?.monthlyCostLimitUsd) return;

    const periodStart = new Date();
    periodStart.setUTCDate(1);
    periodStart.setUTCHours(0, 0, 0, 0);

    const totals = await this.redis.remember(
      this.redis.key(organizationId, 'ai-spend', periodStart.toISOString().slice(0, 7)),
      60,
      async () => {
        const aggregate = await this.prisma.raw.aiUsage.aggregate({
          where: { organizationId, createdAt: { gte: periodStart } },
          _sum: { totalTokens: true, costUsd: true },
        });
        return {
          tokens: aggregate._sum.totalTokens ?? 0,
          costUsd: Number(aggregate._sum.costUsd ?? 0),
        };
      },
    );

    if (policy.monthlyTokenLimit && totals.tokens >= policy.monthlyTokenLimit) {
      throw AppError.quotaExceeded('AI tokens', policy.monthlyTokenLimit);
    }
    if (policy.monthlyCostLimitUsd && totals.costUsd >= Number(policy.monthlyCostLimitUsd)) {
      throw AppError.quotaExceeded('AI spend (USD)', Number(policy.monthlyCostLimitUsd));
    }
  }

  private async recordUsage(
    options: GatewayCallOptions & { provider?: AiProvider },
    response: Pick<CompletionResponse, 'usage' | 'model'>,
    latencyMs: number,
    cached: boolean,
  ): Promise<void> {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return;

    const provider = options.provider ?? 'local';
    const costUsd = cached ? 0 : estimateCostUsd(response.model, response.usage.promptTokens, response.usage.completionTokens);

    this.metrics.aiTokens.inc({ provider, model: response.model, kind: 'prompt' }, response.usage.promptTokens);
    this.metrics.aiTokens.inc({ provider, model: response.model, kind: 'completion' }, response.usage.completionTokens);
    this.metrics.aiCost.inc({ provider, model: response.model }, costUsd);

    // Usage accounting must never break the call it is measuring.
    try {
      await this.prisma.raw.aiUsage.create({
        data: {
          id: newId('aiUsage'),
          organizationId,
          workspaceId: RequestContextStore.workspaceId() ?? null,
          role: options.role ?? 'chat',
          provider,
          model: response.model,
          operation: options.operation ?? 'complete',
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          costUsd: new Prisma.Decimal(costUsd.toFixed(6)),
          latencyMs,
          cached,
          agentId: options.agentId ?? null,
          executionId: options.executionId ?? null,
          conversationId: options.conversationId ?? null,
          userId: RequestContextStore.principal()?.type === 'user' ? (RequestContextStore.principal()?.id ?? null) : null,
        },
      });

      await this.events.publish(DomainEvent.AiCompletionFinished, { type: 'ai_usage', id: organizationId }, {
        model: response.model,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        costUsd,
        latencyMs,
      });
    } catch (error) {
      this.logger.error('Failed to record AI usage', error);
    }
  }

  private async cacheKey(role: ModelRole, request: Omit<CompletionRequest, 'model'>): Promise<string> {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(JSON.stringify({ role, messages: request.messages, temperature: request.temperature })).digest('hex');
    return this.redis.key(RequestContextStore.organizationId(), 'ai-cache', digest);
  }

  // ── Administration ─────────────────────────────────────────────────────────

  async listRoutes(organizationId: string) {
    const routes = await this.prisma.db.modelRoute.findMany({ where: { organizationId }, orderBy: { role: 'asc' } });
    const configured = this.configuredProviders();
    return {
      routes,
      availableProviders: configured,
      defaults: Object.fromEntries(
        Object.entries(DEFAULT_MODELS).map(([role, byProvider]) => [
          role,
          Object.entries(byProvider)
            .filter(([provider]) => configured.includes(provider as AiProvider))
            .map(([provider, model]) => ({ provider, model })),
        ]),
      ),
    };
  }

  async upsertRoute(input: {
    role: ModelRole;
    provider: AiProvider;
    model: string;
    fallbacks?: { provider: AiProvider; model: string }[];
    temperature?: number;
    maxTokens?: number;
  }) {
    const organizationId = RequestContextStore.organizationId()!;
    if (!this.providers.has(input.provider)) {
      throw AppError.badRequest(`The ${input.provider} provider is not configured in this deployment`);
    }
    return this.prisma.raw.modelRoute.upsert({
      where: { organizationId_role: { organizationId, role: input.role } },
      create: {
        id: newId('modelRoute'),
        organizationId,
        role: input.role,
        provider: input.provider,
        model: input.model,
        fallbacks: (input.fallbacks ?? []) as Prisma.InputJsonValue,
        temperature: input.temperature ?? null,
        maxTokens: input.maxTokens ?? null,
      },
      update: {
        provider: input.provider,
        model: input.model,
        fallbacks: (input.fallbacks ?? []) as Prisma.InputJsonValue,
        temperature: input.temperature ?? null,
        maxTokens: input.maxTokens ?? null,
      },
    });
  }

  /** Token and cost usage, grouped for the AI dashboard. */
  async usageSummary(params: { from: Date; to: Date }) {
    const rows = await this.prisma.db.aiUsage.groupBy({
      by: ['model', 'provider', 'operation'],
      where: { createdAt: { gte: params.from, lte: params.to } },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true, costUsd: true },
      _avg: { latencyMs: true },
      _count: { _all: true },
    });

    return rows.map((row) => ({
      model: row.model,
      provider: row.provider,
      operation: row.operation,
      calls: row._count._all,
      promptTokens: row._sum.promptTokens ?? 0,
      completionTokens: row._sum.completionTokens ?? 0,
      totalTokens: row._sum.totalTokens ?? 0,
      costUsd: Number(row._sum.costUsd ?? 0),
      averageLatencyMs: Math.round(row._avg.latencyMs ?? 0),
    }));
  }
}
