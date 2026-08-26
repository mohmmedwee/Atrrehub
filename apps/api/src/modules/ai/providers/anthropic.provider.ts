import { AppError } from '../../../core/errors/app-error';
import type {
  AiProviderAdapter,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../provider';

export interface AnthropicConfig {
  apiKey?: string;
  baseUrl: string;
}

/**
 * Anthropic Messages API. System prompts are a top-level field rather than a
 * message, and tool results come back as content blocks, so the shape differs
 * enough from OpenAI's to need its own adapter.
 */
export class AnthropicProvider implements AiProviderAdapter {
  readonly name = 'anthropic';

  constructor(private readonly config: AnthropicConfig) {}

  isConfigured(): boolean {
    return !!this.config.apiKey;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0.3,
      ...(system ? { system } : {}),
      messages,
      ...(request.stop?.length ? { stop_sequences: request.stop } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
    };

    const response = await fetch(`${this.config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new AppError(
        response.status === 429 || response.status >= 500
          ? 'dependency_unavailable'
          : 'bad_request',
        `anthropic returned ${response.status}`,
        {
          meta: {
            status: response.status,
            detail: detail.slice(0, 500),
            retryable: response.status === 429 || response.status >= 500,
          },
        },
      );
    }

    const payload = (await response.json()) as any;
    const blocks: any[] = payload.content ?? [];
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = blocks
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, arguments: block.input ?? {} }));

    return {
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason:
        payload.stop_reason === 'max_tokens'
          ? 'length'
          : payload.stop_reason === 'tool_use'
            ? 'tool_calls'
            : 'stop',
      usage: {
        promptTokens: payload.usage?.input_tokens ?? 0,
        completionTokens: payload.usage?.output_tokens ?? 0,
        totalTokens: (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
      },
      model: payload.model ?? request.model,
    };
  }

  /** Anthropic has no embeddings endpoint; the gateway falls back for this role. */
  async embed(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new AppError('not_implemented', 'The anthropic provider does not offer embeddings');
  }
}
