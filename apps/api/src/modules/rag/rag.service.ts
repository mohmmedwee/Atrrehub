import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../../core/context/request-context';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { MetricsService } from '../../core/metrics/metrics.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AiGateway } from '../ai/gateway.service';

export interface RetrievalHit {
  chunkId: string;
  documentId: string;
  knowledgeBaseId: string;
  title: string;
  heading?: string;
  content: string;
  score: number;
  vectorRank?: number;
  keywordRank?: number;
  uri?: string;
  version: number;
}

export interface RetrievalOptions {
  knowledgeBaseIds?: string[];
  locale?: string;
  topK?: number;
  /** Candidates fused before reranking. */
  candidates?: number;
  minScore?: number;
  rerank?: boolean;
  conversationId?: string;
  executionId?: string;
}

/** Reciprocal rank fusion constant; 60 is the value from the original paper. */
const RRF_K = 60;

/**
 * Retrieval-augmented generation.
 *
 * Hybrid search runs a vector query and a keyword query independently, fuses
 * them with reciprocal rank fusion, then reranks the top candidates. Vector
 * search finds paraphrases; keyword search pins exact terms like an error code
 * or an SKU that embeddings smooth away. Fusion needs no score calibration
 * between the two, which is what makes it robust across embedding models.
 *
 * Access control is applied as a SQL predicate *before* ranking, so relevance
 * can never surface a document the caller may not read.
 */
@Injectable()
export class RagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGateway,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  // ── Indexing ───────────────────────────────────────────────────────────────

  /**
   * Embed and store chunks for a document, replacing whatever was there.
   *
   * Embeddings are written with raw SQL because Prisma cannot bind a pgvector
   * value; the organization id is included in the statement explicitly, since
   * raw queries bypass the tenant guard extension.
   */
  async indexChunks(
    documentId: string,
    knowledgeBaseId: string,
    chunks: { content: string; heading?: string; position: number; tokenCount: number }[],
    locale = 'en',
  ): Promise<number> {
    const organizationId = RequestContextStore.organizationId()!;
    if (!chunks.length) return 0;

    const embedded = await this.gateway.embed(
      chunks.map((chunk) => chunk.content),
      { operation: 'index' },
    );
    const model = embedded.model;

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.chunk.deleteMany({ where: { documentId, organizationId } });

      for (const [index, chunk] of chunks.entries()) {
        const vector = embedded.embeddings[index];
        const id = newId('chunk');
        // `::vector` casts the JSON array literal into the pgvector type.
        await tx.$executeRaw`
          INSERT INTO chunks (
            id, organization_id, knowledge_base_id, document_id, position,
            heading, content, token_count, locale, metadata, embedding_model, embedding, created_at
          ) VALUES (
            ${id}, ${organizationId}, ${knowledgeBaseId}, ${documentId}, ${chunk.position},
            ${chunk.heading ?? null}, ${chunk.content}, ${chunk.tokenCount}, ${locale},
            '{}'::jsonb, ${model}, ${JSON.stringify(vector)}::vector, NOW()
          )
        `;
      }

      await tx.document.update({
        where: { id: documentId },
        data: {
          status: 'indexed',
          chunkCount: chunks.length,
          tokenCount: chunks.reduce((total, chunk) => total + chunk.tokenCount, 0),
          indexedAt: new Date(),
          statusMessage: null,
        },
      });
    });

    this.logger.debug('Indexed document chunks', { documentId, chunks: chunks.length, model });
    return chunks.length;
  }

  async removeDocument(documentId: string): Promise<void> {
    const organizationId = RequestContextStore.organizationId()!;
    await this.prisma.raw.chunk.deleteMany({ where: { documentId, organizationId } });
  }

  // ── Retrieval ──────────────────────────────────────────────────────────────

  async retrieve(query: string, options: RetrievalOptions = {}): Promise<RetrievalHit[]> {
    const organizationId = RequestContextStore.organizationId()!;
    const started = Date.now();
    const topK = options.topK ?? 6;
    const candidates = options.candidates ?? 40;

    // An empty knowledge-base list means "search nothing", not "search all" —
    // an agent scoped to no knowledge must not fall back to everything.
    if (options.knowledgeBaseIds && options.knowledgeBaseIds.length === 0) return [];

    const [vectorHits, keywordHits] = await Promise.all([
      this.vectorSearch(organizationId, query, candidates, options),
      this.keywordSearch(organizationId, query, candidates, options),
    ]);

    const fused = this.fuse(vectorHits, keywordHits);
    const shortlist = fused.slice(0, candidates);

    let ranked = shortlist;
    if (options.rerank !== false && shortlist.length > topK) {
      const rerankStarted = Date.now();
      const results = await this.gateway.rerank(
        query,
        shortlist.map((hit) => hit.content),
        topK,
      );
      this.metrics.retrievalDuration.observe(
        { stage: 'rerank' },
        (Date.now() - rerankStarted) / 1000,
      );
      ranked = results
        .map((result) => ({ ...shortlist[result.index], score: result.score }))
        .filter((hit): hit is RetrievalHit => !!hit);
    }

    const hits = ranked.filter((hit) => hit.score >= (options.minScore ?? 0)).slice(0, topK);

    const latencyMs = Date.now() - started;
    this.metrics.retrievalDuration.observe({ stage: 'total' }, latencyMs / 1000);

    // Retrieval quality is only improvable if it is measured.
    await this.prisma.raw.retrievalLog
      .create({
        data: {
          id: newId('retrievalLog'),
          organizationId,
          query: query.slice(0, 1000),
          knowledgeBaseIds: options.knowledgeBaseIds ?? [],
          hitCount: hits.length,
          topScore: hits[0]?.score ?? null,
          latencyMs,
          conversationId: options.conversationId ?? null,
          executionId: options.executionId ?? null,
        },
      })
      .catch(() => undefined);

    return hits;
  }

  /** Cosine similarity over the HNSW index. */
  private async vectorSearch(
    organizationId: string,
    query: string,
    limit: number,
    options: RetrievalOptions,
  ): Promise<RetrievalHit[]> {
    const started = Date.now();
    const embedded = await this.gateway.embed([query], { operation: 'retrieve' });
    const vector = embedded.embeddings[0];
    if (!vector) return [];

    const kbFilter = options.knowledgeBaseIds?.length
      ? `AND c.knowledge_base_id = ANY($3::text[])`
      : '';
    const localeFilter = options.locale
      ? `AND c.locale = $${options.knowledgeBaseIds?.length ? 4 : 3}`
      : '';

    const params: unknown[] = [organizationId, JSON.stringify(vector)];
    if (options.knowledgeBaseIds?.length) params.push(options.knowledgeBaseIds);
    if (options.locale) params.push(options.locale);

    const rows = await this.prisma.raw.$queryRawUnsafe<
      {
        chunk_id: string;
        document_id: string;
        knowledge_base_id: string;
        title: string;
        heading: string | null;
        content: string;
        distance: number;
        uri: string | null;
        version: number;
      }[]
    >(
      `SELECT c.id AS chunk_id, c.document_id, c.knowledge_base_id, d.title, c.heading, c.content,
              (c.embedding <=> $2::vector) AS distance, d.uri, d.version
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE c.organization_id = $1
          AND c.embedding IS NOT NULL
          ${kbFilter}
          ${localeFilter}
        ORDER BY c.embedding <=> $2::vector
        LIMIT ${Math.max(1, Math.min(limit, 200))}`,
      ...params,
    );

    this.metrics.retrievalDuration.observe({ stage: 'vector' }, (Date.now() - started) / 1000);

    return rows.map((row, index) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      knowledgeBaseId: row.knowledge_base_id,
      title: row.title,
      heading: row.heading ?? undefined,
      content: row.content,
      // Cosine distance in [0,2]; convert to a similarity in [0,1].
      score: Math.max(0, 1 - row.distance / 2),
      vectorRank: index + 1,
      uri: row.uri ?? undefined,
      version: row.version,
    }));
  }

  /** Postgres full-text search over the generated tsvector column. */
  private async keywordSearch(
    organizationId: string,
    query: string,
    limit: number,
    options: RetrievalOptions,
  ): Promise<RetrievalHit[]> {
    const started = Date.now();
    const kbFilter = options.knowledgeBaseIds?.length
      ? `AND c.knowledge_base_id = ANY($3::text[])`
      : '';
    const params: unknown[] = [organizationId, query];
    if (options.knowledgeBaseIds?.length) params.push(options.knowledgeBaseIds);

    const rows = await this.prisma.raw
      .$queryRawUnsafe<
        {
          chunk_id: string;
          document_id: string;
          knowledge_base_id: string;
          title: string;
          heading: string | null;
          content: string;
          rank: number;
          uri: string | null;
          version: number;
        }[]
      >(
        `SELECT c.id AS chunk_id, c.document_id, c.knowledge_base_id, d.title, c.heading, c.content,
                ts_rank(c.search_vector, websearch_to_tsquery('simple', $2)) AS rank, d.uri, d.version
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
          WHERE c.organization_id = $1
            AND c.search_vector @@ websearch_to_tsquery('simple', $2)
            ${kbFilter}
          ORDER BY rank DESC
          LIMIT ${Math.max(1, Math.min(limit, 200))}`,
        ...params,
      )
      // A malformed query string must not fail the whole retrieval — the vector
      // side can still answer.
      .catch((error) => {
        this.logger.debug('Keyword search skipped', { reason: String(error) });
        return [];
      });

    this.metrics.retrievalDuration.observe({ stage: 'keyword' }, (Date.now() - started) / 1000);

    return rows.map((row, index) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      knowledgeBaseId: row.knowledge_base_id,
      title: row.title,
      heading: row.heading ?? undefined,
      content: row.content,
      score: row.rank,
      keywordRank: index + 1,
      uri: row.uri ?? undefined,
      version: row.version,
    }));
  }

  /**
   * Reciprocal rank fusion: score each result by 1/(k + rank) in each list and
   * sum. Rank-based fusion needs no calibration between a cosine similarity and
   * a ts_rank, which are not comparable quantities.
   */
  fuse(vectorHits: RetrievalHit[], keywordHits: RetrievalHit[]): RetrievalHit[] {
    const merged = new Map<string, RetrievalHit & { fusedScore: number }>();

    const add = (hits: RetrievalHit[], rankKey: 'vectorRank' | 'keywordRank') => {
      hits.forEach((hit, index) => {
        const rank = index + 1;
        const contribution = 1 / (RRF_K + rank);
        const existing = merged.get(hit.chunkId);
        if (existing) {
          existing.fusedScore += contribution;
          existing[rankKey] = rank;
        } else {
          merged.set(hit.chunkId, { ...hit, [rankKey]: rank, fusedScore: contribution });
        }
      });
    };

    add(vectorHits, 'vectorRank');
    add(keywordHits, 'keywordRank');

    return [...merged.values()]
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .map(({ fusedScore, ...hit }) => ({ ...hit, score: fusedScore }));
  }

  /**
   * Render hits as prompt context with stable citation markers, and return the
   * citation list so an answer can be traced back to its sources.
   */
  buildContext(hits: RetrievalHit[]): {
    context: string;
    citations: {
      index: number;
      documentId: string;
      chunkId: string;
      title: string;
      heading?: string;
      uri?: string;
      version: number;
    }[];
  } {
    const citations = hits.map((hit, index) => ({
      index: index + 1,
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      title: hit.title,
      heading: hit.heading,
      uri: hit.uri,
      version: hit.version,
    }));

    const context = hits
      .map(
        (hit, index) =>
          `[${index + 1}] ${hit.title}${hit.heading ? ` — ${hit.heading}` : ''}\n${hit.content}`,
      )
      .join('\n\n');

    return { context, citations };
  }

  /**
   * Judge whether an answer is supported by the retrieved context.
   *
   * Term overlap is a cheap proxy, but it reliably catches the failure that
   * matters — an answer asserting specifics that appear nowhere in the sources.
   */
  groundedness(answer: string, hits: RetrievalHit[]): { score: number; unsupported: string[] } {
    if (!hits.length) return { score: 0, unsupported: [] };

    const contextTerms = new Set(
      hits
        .flatMap((hit) => hit.content.toLowerCase().split(/[^\p{L}\p{N}]+/u))
        .filter((term) => term.length > 3),
    );

    const sentences = answer
      .split(/(?<=[.!?؟])\s+/)
      .filter((sentence) => sentence.trim().length > 15);
    if (!sentences.length) return { score: 1, unsupported: [] };

    const unsupported: string[] = [];
    let supported = 0;

    for (const sentence of sentences) {
      const terms = sentence
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 3);
      if (!terms.length) {
        supported += 1;
        continue;
      }
      const overlap = terms.filter((term) => contextTerms.has(term)).length / terms.length;
      if (overlap >= 0.4) supported += 1;
      else unsupported.push(sentence.trim());
    }

    return { score: supported / sentences.length, unsupported };
  }

  /** Retrieval quality metrics for the AI dashboard. */
  async retrievalStats(params: { from: Date; to: Date }) {
    const logs = await this.prisma.db.retrievalLog.findMany({
      where: { createdAt: { gte: params.from, lte: params.to } },
      select: { hitCount: true, topScore: true, latencyMs: true },
    });
    if (!logs.length)
      return { queries: 0, zeroHitRate: 0, averageLatencyMs: 0, averageTopScore: 0 };

    const zeroHits = logs.filter((log) => log.hitCount === 0).length;
    return {
      queries: logs.length,
      zeroHitRate: Math.round((zeroHits / logs.length) * 1000) / 10,
      averageLatencyMs: Math.round(
        logs.reduce((total, log) => total + log.latencyMs, 0) / logs.length,
      ),
      averageTopScore:
        Math.round(
          (logs.reduce((total, log) => total + (log.topScore ?? 0), 0) / logs.length) * 1000,
        ) / 1000,
    };
  }
}
