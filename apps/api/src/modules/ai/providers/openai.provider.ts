import { AppError } from '../../../core/errors/app-error';
import type {
  AiProviderAdapter,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../provider';

export interface OpenAiConfig {
  apiKey?: string;
  baseUrl: string;
  /** Azure OpenAI addresses deployments rather than models. */
  azure?: { endpoint?: string; apiVersion: string };
}

/** OpenAI and Azure OpenAI share a wire format, so one adapter serves both. */
export class OpenAiProvider implements AiProviderAdapter {
  readonly name: string;

  constructor(
    private readonly config: OpenAiConfig,
    isAzure = false,
  ) {
    this.name = isAzure ? 'azure_openai' : 'openai';
  }

  isConfigured(): boolean {
    return !!this.config.apiKey && (this.name !== 'azure_openai' || !!this.config.azure?.endpoint);
  }

  private url(path: string, model: string): string {
    if (this.name === 'azure_openai') {
      return `${this.config.azure!.endpoint}/openai/deployments/${model}${path}?api-version=${this.config.azure!.apiVersion}`;
    }
    return `${this.config.baseUrl}${path}`;
  }

  private headers(): Record<string, string> {
    return this.name === 'azure_openai'
      ? { 'content-type': 'application/json', 'api-key': this.config.apiKey! }
      : { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` };
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      })),
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.stop?.length ? { stop: request.stop } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
          }
        : {}),
      ...(request.responseSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'response', schema: request.responseSchema, strict: false },
            },
          }
        : {}),
    };

    const payload = await this.request(this.url('/chat/completions', request.model), body);
    const choice = payload.choices?.[0];
    const toolCalls = choice?.message?.tool_calls?.map((call: any) => ({
      id: call.id,
      name: call.function?.name,
      arguments: safeParse(call.function?.arguments),
    }));

    return {
      content: choice?.message?.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        completionTokens: payload.usage?.completion_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ?? 0,
      },
      model: payload.model ?? request.model,
      // Average log-probability, where the provider returns it, as a confidence proxy.
      confidence: deriveConfidence(choice?.logprobs),
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const payload = await this.request(this.url('/embeddings', request.model), {
      model: request.model,
      input: request.input,
      ...(request.dimensions ? { dimensions: request.dimensions } : {}),
    });

    return {
      embeddings: (payload.data ?? []).map((row: any) => row.embedding as number[]),
      model: payload.model ?? request.model,
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ?? 0,
      },
    };
  }

  async *stream(request: CompletionRequest) {
    const response = await fetch(this.url('/chat/completions', request.model), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens ?? 1024,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!response.ok || !response.body) throw AppError.dependency(this.name);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are newline-delimited; the last partial line stays buffered.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          yield { delta: '', done: true };
          return;
        }
        const parsed = safeParse(data);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (delta) yield { delta, done: false };
        if (parsed?.usage) {
          yield {
            delta: '',
            done: false,
            usage: {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0,
            },
          };
        }
      }
    }
    yield { delta: '', done: true };
  }

  private async request(url: string, body: unknown): Promise<any> {
    const response = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Rate limits and overloads are retryable; the gateway decides.
      throw new AppError(
        response.status === 429 || response.status >= 500 ? 'dependency_unavailable' : 'bad_request',
        `${this.name} returned ${response.status}`,
        { meta: { status: response.status, detail: detail.slice(0, 500), retryable: response.status === 429 || response.status >= 500 } },
      );
    }
    return response.json();
  }
}

function safeParse(value: unknown): any {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function mapFinishReason(reason: string | undefined): CompletionResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function deriveConfidence(logprobs: any): number | undefined {
  const tokens = logprobs?.content;
  if (!Array.isArray(tokens) || !tokens.length) return undefined;
  const mean = tokens.reduce((total: number, token: any) => total + (token.logprob ?? 0), 0) / tokens.length;
  return Math.max(0, Math.min(1, Math.exp(mean)));
}
