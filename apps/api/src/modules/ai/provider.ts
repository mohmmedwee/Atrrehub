/** The provider-facing contract. Everything above the gateway speaks only this. */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSchema[];
  /** Ask the model to emit JSON conforming to this schema. */
  responseSchema?: Record<string, unknown>;
  stop?: string[];
}

export interface CompletionResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
  /** 0-1 where the provider exposes one; the gateway derives a proxy otherwise. */
  confidence?: number;
}

export interface EmbeddingRequest {
  input: string[];
  model: string;
  dimensions?: number;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage: { promptTokens: number; totalTokens: number };
}

export interface RerankRequest {
  query: string;
  documents: string[];
  model: string;
  topN?: number;
}

export interface RerankResponse {
  /** Indices into the input documents, best first, with relevance scores. */
  results: { index: number; score: number }[];
  model: string;
}

export interface AiProviderAdapter {
  readonly name: string;
  /** False when the provider has no credentials configured. */
  isConfigured(): boolean;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  rerank?(request: RerankRequest): Promise<RerankResponse>;
  /** Streaming completions, where the provider supports them. */
  stream?(
    request: CompletionRequest,
  ): AsyncIterable<{ delta: string; done: boolean; usage?: CompletionResponse['usage'] }>;
}

/**
 * Approximate token cost per model, in USD per 1M tokens. Used for budget
 * enforcement and cost reporting; providers that return exact billing data
 * override these figures.
 */
export const MODEL_PRICING: Record<string, { prompt: number; completion: number }> = {
  'gpt-4o': { prompt: 2.5, completion: 10 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  'claude-sonnet-4-5': { prompt: 3, completion: 15 },
  'claude-haiku-4-5': { prompt: 1, completion: 5 },
  'gemini-2.0-flash': { prompt: 0.1, completion: 0.4 },
  'text-embedding-3-small': { prompt: 0.02, completion: 0 },
  'text-embedding-3-large': { prompt: 0.13, completion: 0 },
  local: { prompt: 0, completion: 0 },
};

export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING.local;
  return (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1_000_000;
}

/**
 * Token estimate for budgeting and truncation when a provider does not report
 * usage. Roughly four characters per token for Latin scripts; Arabic and other
 * non-Latin scripts run denser, so they are weighted accordingly.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const nonLatin = (text.match(/[^\x00-\x7F]/g) ?? []).length;
  const latin = text.length - nonLatin;
  return Math.ceil(latin / 4 + nonLatin / 2);
}
