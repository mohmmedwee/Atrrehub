import { createHash } from 'node:crypto';
import type {
  AiProviderAdapter,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  RerankRequest,
  RerankResponse,
} from '../provider';
import { estimateTokens } from '../provider';

/**
 * A deterministic, dependency-free provider.
 *
 * The whole platform — agents, RAG, QC, evaluation — runs and is testable with
 * no API key and no network. It is not a language model: it produces
 * structured, rule-derived answers from the prompt and the retrieved context,
 * which is exactly what development, CI and demos need, and what makes the
 * evaluation suite reproducible.
 */
export class LocalProvider implements AiProviderAdapter {
  readonly name = 'local';

  isConfigured(): boolean {
    return true;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const context = this.extractContext(system);

    // Structured output: satisfy the requested schema rather than free text.
    if (request.responseSchema) {
      const payload = this.synthesizeSchema(request.responseSchema, lastUser, context);
      return this.respond(JSON.stringify(payload), request, 'stop');
    }

    // Tool selection: pick a tool when the question clearly names its subject.
    if (request.tools?.length) {
      const tool = this.selectTool(request.tools, lastUser);
      if (tool) {
        return {
          content: '',
          toolCalls: [
            {
              id: `call_${this.hash(lastUser).slice(0, 12)}`,
              name: tool.name,
              arguments: this.synthesizeSchema(tool.parameters, lastUser, context) as Record<
                string,
                unknown
              >,
            },
          ],
          finishReason: 'tool_calls',
          usage: this.usage(request, ''),
          model: request.model,
          confidence: 0.8,
        };
      }
    }

    const answer = this.answer(lastUser, context);
    return this.respond(answer.text, request, 'stop', answer.confidence);
  }

  /**
   * Hash-based embeddings. Deterministic and cheap, and similar strings share
   * many tokens so cosine similarity still ranks related text together — enough
   * for retrieval to be exercised end to end without a model.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const dimensions = request.dimensions ?? 1536;
    const embeddings = request.input.map((text) => this.embedOne(text, dimensions));
    const promptTokens = request.input.reduce((total, text) => total + estimateTokens(text), 0);
    return { embeddings, model: request.model, usage: { promptTokens, totalTokens: promptTokens } };
  }

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const queryTerms = this.terms(request.query);
    const scored = request.documents.map((document, index) => {
      const documentTerms = this.terms(document);
      const overlap = [...queryTerms].filter((term) => documentTerms.has(term)).length;
      // Normalize by query length so long documents do not win on volume alone.
      const score = queryTerms.size ? overlap / queryTerms.size : 0;
      return { index, score };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return { results: scored.slice(0, request.topN ?? scored.length), model: request.model };
  }

  async *stream(request: CompletionRequest) {
    const response = await this.complete(request);
    // Chunk on word boundaries so consumers exercise real partial rendering.
    const words = response.content.split(/(\s+)/);
    for (const word of words) {
      if (word) yield { delta: word, done: false };
    }
    yield { delta: '', done: true, usage: response.usage };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private respond(
    content: string,
    request: CompletionRequest,
    finishReason: CompletionResponse['finishReason'],
    confidence = 0.75,
  ): CompletionResponse {
    return {
      content,
      finishReason,
      usage: this.usage(request, content),
      model: request.model,
      confidence,
    };
  }

  private usage(request: CompletionRequest, output: string) {
    const promptTokens = request.messages.reduce(
      (total, message) => total + estimateTokens(message.content),
      0,
    );
    const completionTokens = estimateTokens(output);
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }

  /** Retrieved passages are injected between markers by the agent runtime. */
  private extractContext(system: string): string[] {
    const match = /<context>([\s\S]*?)<\/context>/.exec(system);
    if (!match) return [];
    return match[1]
      .split(/\n(?=\[\d+\])/)
      .map((chunk) => chunk.trim())
      .filter(Boolean);
  }

  /**
   * Answer from the retrieved context when it overlaps the question, otherwise
   * say so plainly and report low confidence — which is precisely the signal
   * the guardrail layer uses to hand off to a human.
   */
  private answer(question: string, context: string[]): { text: string; confidence: number } {
    if (!context.length) {
      return {
        text: "I don't have information about that in the knowledge available to me. Let me pass you to a colleague who can help.",
        confidence: 0.2,
      };
    }

    const questionTerms = this.terms(question);
    const ranked = context
      .map((passage) => {
        const passageTerms = this.terms(passage);
        const overlap = [...questionTerms].filter((term) => passageTerms.has(term)).length;
        return { passage, score: questionTerms.size ? overlap / questionTerms.size : 0 };
      })
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (!best || best.score < 0.15) {
      return {
        text: "I couldn't find a confident answer in our knowledge base for that. I'll hand this to a colleague.",
        confidence: 0.25,
      };
    }

    const sentences = best.passage
      .replace(/^\[\d+\]\s*/, '')
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');

    return {
      text: sentences,
      // Overlap is a crude proxy, but it moves in the right direction and keeps
      // the confidence-threshold handoff path exercised.
      confidence: Math.min(0.95, 0.5 + best.score / 2),
    };
  }

  private selectTool(tools: CompletionRequest['tools'], question: string) {
    const questionTerms = this.terms(question);
    let best: { tool: NonNullable<CompletionRequest['tools']>[number]; score: number } | null =
      null;
    for (const tool of tools ?? []) {
      const toolTerms = this.terms(`${tool.name} ${tool.description}`);
      const overlap = [...questionTerms].filter((term) => toolTerms.has(term)).length;
      const score = questionTerms.size ? overlap / questionTerms.size : 0;
      if (score > 0.3 && (!best || score > best.score)) best = { tool, score };
    }
    return best?.tool ?? null;
  }

  /** Build a value that satisfies a JSON Schema, drawing on the prompt where it can. */
  private synthesizeSchema(
    schema: Record<string, unknown>,
    question: string,
    context: string[],
  ): unknown {
    const type = schema.type as string | undefined;

    if (schema.enum && Array.isArray(schema.enum)) {
      const lowered = question.toLowerCase();
      const match = (schema.enum as unknown[]).find((value) =>
        lowered.includes(String(value).toLowerCase()),
      );
      return match ?? schema.enum[0];
    }

    switch (type) {
      case 'object': {
        const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
        const out: Record<string, unknown> = {};
        for (const [key, propertySchema] of Object.entries(properties)) {
          out[key] = this.synthesizeSchema(propertySchema, question, context);
        }
        return out;
      }
      case 'array': {
        const items = (schema.items ?? { type: 'string' }) as Record<string, unknown>;
        return [this.synthesizeSchema(items, question, context)];
      }
      case 'number':
      case 'integer': {
        // Stable pseudo-value in 0-100 so numeric fields are reproducible.
        const value = parseInt(this.hash(question).slice(0, 4), 16) % 101;
        return type === 'integer' ? value : value / 100;
      }
      case 'boolean':
        return parseInt(this.hash(question).slice(0, 2), 16) % 2 === 0;
      case 'string':
      default: {
        if (typeof schema.description === 'string' && /summar/i.test(schema.description)) {
          return this.answer(question, context).text;
        }
        return question.slice(0, 200) || 'unknown';
      }
    }
  }

  private embedOne(text: string, dimensions: number): number[] {
    const vector = new Array<number>(dimensions).fill(0);
    for (const term of this.terms(text)) {
      const digest = createHash('sha256').update(term).digest();
      // Spread each term over a few dimensions so vectors stay dense enough
      // for cosine similarity to separate documents.
      for (let slot = 0; slot < 4; slot += 1) {
        const index = digest.readUInt32BE(slot * 4) % dimensions;
        vector[index] += slot % 2 === 0 ? 1 : -1;
      }
    }
    const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  }

  private terms(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((term) => term.length > 2 && !STOP_WORDS.has(term)),
    );
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'have',
  'this',
  'that',
  'with',
  'from',
  'they',
  'been',
  'were',
  'their',
  'what',
  'when',
  'your',
  'about',
  'would',
  'there',
  'could',
  'other',
  'into',
  'more',
  'some',
  'will',
  'how',
  'why',
]);
