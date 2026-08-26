import { Injectable } from '@nestjs/common';
import { Prisma, type SourceType } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { QUEUES, QueueService } from '../../core/queue/queue.service';
import { StorageService } from '../../core/storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { chunkDocument } from '../rag/chunker';
import { RagService } from '../rag/rag.service';
import { cleanText, parseContent, parseHtmlContent } from './parsers';
import { cursorArgs, paginate, type CursorParams } from '../../common/pagination';

/**
 * Knowledge management and the ingestion half of the RAG pipeline:
 * `parse → clean → chunk → embed → index`.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rag: RagService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly logger: AppLogger,
  ) {}

  // ── Knowledge bases ────────────────────────────────────────────────────────

  async listBases() {
    return this.prisma.db.knowledgeBase.findMany({
      where: {},
      include: { _count: { select: { articles: true, documents: true, sources: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async createBase(input: {
    name: string;
    key: string;
    description?: string;
    locale?: string;
    readRoles?: string[];
    isPublic?: boolean;
    workspaceId?: string;
  }) {
    const existing = await this.prisma.db.knowledgeBase.findFirst({ where: { key: input.key } });
    if (existing)
      throw AppError.conflict(`A knowledge base with the key "${input.key}" already exists`);

    return this.prisma.db.knowledgeBase.create({
      data: {
        id: newId('knowledgeBase'),
        name: input.name,
        key: input.key,
        description: input.description ?? null,
        locale: input.locale ?? 'en',
        readRoles: input.readRoles ?? [],
        isPublic: input.isPublic ?? false,
        workspaceId: input.workspaceId ?? null,
      } as never,
    });
  }

  async getBase(knowledgeBaseId: string) {
    const base = await this.prisma.db.knowledgeBase.findFirst({
      where: { id: knowledgeBaseId },
      include: {
        categories: { orderBy: { position: 'asc' } },
        _count: { select: { articles: true, documents: true } },
      },
    });
    if (!base) throw AppError.notFound('Knowledge base', knowledgeBaseId);
    return base;
  }

  async updateBase(knowledgeBaseId: string, patch: Record<string, unknown>) {
    return this.prisma.db.knowledgeBase.update({
      where: { id: knowledgeBaseId },
      data: patch as never,
    });
  }

  async deleteBase(knowledgeBaseId: string) {
    await this.prisma.db.knowledgeBase.delete({ where: { id: knowledgeBaseId } });
    await this.audit.record({
      action: 'knowledge_base.deleted',
      resourceType: 'knowledge_base',
      resourceId: knowledgeBaseId,
    });
  }

  /**
   * The bases the current principal may read. Applied as a filter before
   * ranking, so retrieval can never surface knowledge above the caller's level.
   */
  async readableBaseIds(): Promise<string[]> {
    const principal = RequestContextStore.principal();
    const bases = await this.prisma.db.knowledgeBase.findMany({
      where: {},
      select: { id: true, readRoles: true, isPublic: true },
    });
    if (!principal) return bases.filter((base) => base.isPublic).map((base) => base.id);
    if (principal.permissions.includes('*')) return bases.map((base) => base.id);

    return bases
      .filter(
        (base) =>
          base.isPublic ||
          !base.readRoles.length ||
          (principal.roleKey && base.readRoles.includes(principal.roleKey)),
      )
      .map((base) => base.id);
  }

  // ── Categories ─────────────────────────────────────────────────────────────

  async createCategory(
    knowledgeBaseId: string,
    input: { name: string; slug?: string; parentId?: string; position?: number },
  ) {
    const slug = (input.slug ?? input.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return this.prisma.db.knowledgeCategory.create({
      data: {
        id: newId('category'),
        knowledgeBaseId,
        name: input.name,
        slug,
        parentId: input.parentId ?? null,
        position: input.position ?? 0,
      } as never,
    });
  }

  async deleteCategory(categoryId: string) {
    await this.prisma.db.knowledgeCategory.delete({ where: { id: categoryId } });
  }

  // ── Articles ───────────────────────────────────────────────────────────────

  async listArticles(
    params: CursorParams & {
      knowledgeBaseId?: string;
      state?: string;
      categoryId?: string;
      q?: string;
    },
  ) {
    const where: Prisma.ArticleWhereInput = {
      ...(params.knowledgeBaseId ? { knowledgeBaseId: params.knowledgeBaseId } : {}),
      ...(params.state ? { state: params.state as never } : {}),
      ...(params.categoryId ? { categoryId: params.categoryId } : {}),
      ...(params.q
        ? {
            OR: [
              { title: { contains: params.q, mode: 'insensitive' } },
              { summary: { contains: params.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.db.article.findMany({
      where,
      select: {
        id: true,
        title: true,
        slug: true,
        summary: true,
        state: true,
        version: true,
        locale: true,
        tags: true,
        publishedAt: true,
        viewCount: true,
        updatedAt: true,
        knowledgeBaseId: true,
        categoryId: true,
      },
      orderBy: { updatedAt: 'desc' },
      ...cursorArgs(params),
    });
    return paginate(rows, params.limit);
  }

  async createArticle(input: {
    knowledgeBaseId: string;
    title: string;
    body: string;
    summary?: string;
    slug?: string;
    categoryId?: string;
    locale?: string;
    tags?: string[];
    keywords?: string[];
  }) {
    const principal = RequestContextStore.principal();
    const slug = (input.slug ?? input.title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);

    const clash = await this.prisma.db.article.findFirst({
      where: { knowledgeBaseId: input.knowledgeBaseId, slug },
    });
    if (clash)
      throw AppError.conflict(
        `An article with the slug "${slug}" already exists in this knowledge base`,
      );

    const article = await this.prisma.db.article.create({
      data: {
        id: newId('article'),
        knowledgeBaseId: input.knowledgeBaseId,
        categoryId: input.categoryId ?? null,
        title: input.title,
        slug,
        body: input.body,
        summary: input.summary ?? null,
        locale: input.locale ?? 'en',
        tags: input.tags ?? [],
        keywords: input.keywords ?? [],
        authorId: principal?.id ?? null,
        state: 'draft',
        version: 1,
      } as never,
    });

    await this.audit.record({
      action: 'article.created',
      resourceType: 'article',
      resourceId: article.id,
      after: { title: input.title },
    });
    return article;
  }

  async getArticle(articleId: string) {
    const article = await this.prisma.db.article.findFirst({
      where: { id: articleId },
      include: { versions: { orderBy: { version: 'desc' }, take: 10 }, category: true },
    });
    if (!article) throw AppError.notFound('Article', articleId);
    return article;
  }

  /**
   * Update an article. A content change snapshots the previous revision and
   * bumps the version, so publishing history stays auditable.
   */
  async updateArticle(
    articleId: string,
    patch: {
      title?: string;
      body?: string;
      summary?: string;
      categoryId?: string;
      tags?: string[];
      keywords?: string[];
      changeNote?: string;
    },
  ) {
    const before = await this.getArticle(articleId);
    const contentChanged =
      (patch.title && patch.title !== before.title) || (patch.body && patch.body !== before.body);
    const principal = RequestContextStore.principal();
    const organizationId = RequestContextStore.organizationId()!;

    const { changeNote, ...data } = patch;

    const after = await this.prisma.raw.$transaction(async (tx) => {
      if (contentChanged) {
        await tx.articleVersion.create({
          data: {
            id: newId('articleVersion'),
            organizationId,
            articleId,
            version: before.version,
            title: before.title,
            body: before.body,
            authorId: before.authorId,
            changeNote: changeNote ?? null,
          },
        });
      }
      return tx.article.update({
        where: { id: articleId },
        data: {
          ...data,
          ...(contentChanged
            ? { version: { increment: 1 }, authorId: principal?.id ?? before.authorId }
            : {}),
        } as never,
      });
    });

    // A published article's index must reflect what was published.
    if (contentChanged && after.state === 'published') {
      await this.indexArticle(articleId);
    }

    await this.audit.recordDiff(
      'article.updated',
      'article',
      articleId,
      before as never,
      after as never,
    );
    return after;
  }

  async publishArticle(articleId: string) {
    const article = await this.prisma.db.article.update({
      where: { id: articleId },
      data: { state: 'published', publishedAt: new Date() },
    });
    await this.indexArticle(articleId);

    await this.events.publish(
      DomainEvent.KnowledgeArticlePublished,
      { type: 'article', id: articleId },
      {
        articleId,
        version: article.version,
      },
    );
    await this.audit.record({
      action: 'article.published',
      resourceType: 'article',
      resourceId: articleId,
    });
    return article;
  }

  async unpublishArticle(articleId: string) {
    const article = await this.prisma.db.article.update({
      where: { id: articleId },
      data: { state: 'draft' },
    });
    // Unpublished knowledge must stop grounding AI answers immediately.
    const document = await this.prisma.db.document.findFirst({ where: { articleId } });
    if (document) {
      await this.rag.removeDocument(document.id);
      await this.prisma.db.document.update({
        where: { id: document.id },
        data: { status: 'skipped', chunkCount: 0 },
      });
    }
    return article;
  }

  async deleteArticle(articleId: string) {
    const document = await this.prisma.db.document.findFirst({ where: { articleId } });
    if (document) await this.rag.removeDocument(document.id);
    await this.prisma.db.article.delete({ where: { id: articleId } });
    await this.audit.record({
      action: 'article.deleted',
      resourceType: 'article',
      resourceId: articleId,
    });
  }

  /** Mirror a published article into the document/chunk index. */
  private async indexArticle(articleId: string) {
    const article = await this.getArticle(articleId);
    const organizationId = RequestContextStore.organizationId()!;

    const document = await this.prisma.raw.document.upsert({
      where: { articleId },
      create: {
        id: newId('document'),
        organizationId,
        knowledgeBaseId: article.knowledgeBaseId,
        articleId,
        title: article.title,
        type: 'article',
        text: article.body,
        locale: article.locale,
        contentHash: this.crypto.contentHash(article.body),
        status: 'processing',
        version: article.version,
      },
      update: {
        title: article.title,
        text: article.body,
        contentHash: this.crypto.contentHash(article.body),
        status: 'processing',
        version: article.version,
      },
    });

    const chunks = chunkDocument(
      `# ${article.title}\n\n${article.summary ? `${article.summary}\n\n` : ''}${article.body}`,
    );
    await this.rag.indexChunks(document.id, article.knowledgeBaseId, chunks, article.locale);
    await this.events.publish(
      DomainEvent.RagIndexed,
      { type: 'document', id: document.id },
      {
        documentId: document.id,
        chunkCount: chunks.length,
      },
    );
  }

  // ── Documents ──────────────────────────────────────────────────────────────

  async listDocuments(params: CursorParams & { knowledgeBaseId?: string; status?: string }) {
    const rows = await this.prisma.db.document.findMany({
      where: {
        ...(params.knowledgeBaseId ? { knowledgeBaseId: params.knowledgeBaseId } : {}),
        ...(params.status ? { status: params.status as never } : {}),
      },
      select: {
        id: true,
        title: true,
        type: true,
        uri: true,
        status: true,
        statusMessage: true,
        chunkCount: true,
        tokenCount: true,
        locale: true,
        indexedAt: true,
        createdAt: true,
        knowledgeBaseId: true,
      },
      orderBy: { createdAt: 'desc' },
      ...cursorArgs(params),
    });
    return paginate(rows, params.limit);
  }

  /**
   * Accept an uploaded file. The document row is created immediately so the
   * upload is visible, and the expensive parse/embed work is queued.
   */
  async uploadDocument(input: {
    knowledgeBaseId: string;
    filename: string;
    contentType: string;
    content: Buffer;
    locale?: string;
    title?: string;
  }) {
    const organizationId = RequestContextStore.organizationId()!;
    const contentHash = this.crypto.contentHash(input.content.toString('base64'));

    // Re-uploading an identical file should not duplicate the index.
    const duplicate = await this.prisma.db.document.findFirst({
      where: { knowledgeBaseId: input.knowledgeBaseId, contentHash },
    });
    if (duplicate) return duplicate;

    const key = this.storage.buildKey(organizationId, 'knowledge', input.filename);
    const stored = await this.storage.put(key, input.content, input.contentType);

    const document = await this.prisma.db.document.create({
      data: {
        id: newId('document'),
        knowledgeBaseId: input.knowledgeBaseId,
        title: input.title ?? input.filename,
        type: 'file',
        contentType: input.contentType,
        storageKey: stored.key,
        contentHash,
        locale: input.locale ?? 'en',
        status: 'pending',
      } as never,
    });

    await this.queue.enqueue(QUEUES.ingestion, 'ingest-document', { documentId: document.id });
    return document;
  }

  /** Ingest a URL's content directly. */
  async ingestUrl(input: { knowledgeBaseId: string; url: string; locale?: string }) {
    const document = await this.prisma.db.document.create({
      data: {
        id: newId('document'),
        knowledgeBaseId: input.knowledgeBaseId,
        title: input.url,
        type: 'url',
        uri: input.url,
        locale: input.locale ?? 'en',
        status: 'pending',
      } as never,
    });
    await this.queue.enqueue(QUEUES.ingestion, 'ingest-document', { documentId: document.id });
    return document;
  }

  /**
   * Parse, clean, chunk, embed and index one document. Runs on the worker tier;
   * a failure is recorded on the document so it is visible and retryable rather
   * than silently missing from search.
   */
  async processDocument(documentId: string): Promise<{ chunks: number }> {
    const document = await this.prisma.db.document.findFirst({ where: { id: documentId } });
    if (!document) throw AppError.notFound('Document', documentId);

    await this.prisma.db.document.update({
      where: { id: documentId },
      data: { status: 'processing' },
    });

    try {
      let text = document.text ?? '';
      let title = document.title;

      if (!text && document.storageKey) {
        const content = await this.storage.get(document.storageKey);
        const parsed = await parseContent(
          content,
          document.contentType ?? 'text/plain',
          document.title,
        );
        text = parsed.text;
        title = parsed.title ?? title;
      } else if (!text && document.uri) {
        const parsed = await this.fetchUrl(document.uri);
        text = parsed.text;
        title = parsed.title ?? title;
      } else {
        text = cleanText(text);
      }

      if (!text.trim()) {
        await this.prisma.db.document.update({
          where: { id: documentId },
          data: {
            status: 'failed',
            statusMessage: 'No extractable text — the file may be scanned or empty',
          },
        });
        return { chunks: 0 };
      }

      const chunks = chunkDocument(text);
      await this.prisma.db.document.update({
        where: { id: documentId },
        data: { text: text.slice(0, 2_000_000), title, contentHash: this.crypto.contentHash(text) },
      });
      await this.rag.indexChunks(documentId, document.knowledgeBaseId, chunks, document.locale);

      await this.events.publish(
        DomainEvent.KnowledgeDocumentIngested,
        { type: 'document', id: documentId },
        {
          documentId,
          chunks: chunks.length,
        },
      );
      return { chunks: chunks.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.db.document.update({
        where: { id: documentId },
        data: { status: 'failed', statusMessage: message.slice(0, 500) },
      });
      this.logger.error('Document ingestion failed', error, { documentId });
      throw error;
    }
  }

  async deleteDocument(documentId: string) {
    const document = await this.prisma.db.document.findFirst({ where: { id: documentId } });
    if (!document) throw AppError.notFound('Document', documentId);
    await this.rag.removeDocument(documentId);
    if (document.storageKey) await this.storage.delete(document.storageKey).catch(() => undefined);
    await this.prisma.db.document.delete({ where: { id: documentId } });
  }

  /** Fetch a URL, refusing private address space so a source cannot probe the network. */
  private async fetchUrl(url: string) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw AppError.badRequest('Only http and https sources can be ingested');
    }
    if (isPrivateHost(parsed.hostname)) {
      throw AppError.badRequest('Sources on private networks cannot be ingested');
    }

    const response = await fetch(url, {
      headers: { 'user-agent': 'Atrrehub-KnowledgeCrawler/1.0' },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    if (!response.ok) throw AppError.dependency(`The source returned ${response.status}`);

    const contentType = response.headers.get('content-type') ?? 'text/html';
    const buffer = Buffer.from(await response.arrayBuffer());
    return contentType.includes('html')
      ? parseHtmlContent(buffer.toString('utf8'))
      : parseContent(buffer, contentType);
  }

  // ── Sources ────────────────────────────────────────────────────────────────

  async listSources(knowledgeBaseId?: string) {
    return this.prisma.db.knowledgeSource.findMany({
      where: knowledgeBaseId ? { knowledgeBaseId } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSource(input: {
    knowledgeBaseId: string;
    type: SourceType;
    name: string;
    location?: string;
    config?: Record<string, unknown>;
    syncCron?: string;
  }) {
    const source = await this.prisma.db.knowledgeSource.create({
      data: {
        id: newId('source'),
        knowledgeBaseId: input.knowledgeBaseId,
        type: input.type,
        name: input.name,
        location: input.location ?? null,
        config: (input.config ?? {}) as Prisma.InputJsonValue,
        syncCron: input.syncCron ?? null,
      } as never,
    });
    return source;
  }

  async deleteSource(sourceId: string) {
    await this.prisma.db.knowledgeSource.delete({ where: { id: sourceId } });
  }

  /**
   * Crawl a website source, bounded by page count and depth so one
   * misconfigured source cannot walk an entire domain.
   */
  async syncSource(sourceId: string): Promise<{ added: number; updated: number; failed: number }> {
    const source = await this.prisma.db.knowledgeSource.findFirst({ where: { id: sourceId } });
    if (!source) throw AppError.notFound('Knowledge source', sourceId);
    if (!source.location) throw AppError.badRequest('This source has no location to crawl');

    const config = (source.config ?? {}) as {
      maxPages?: number;
      maxDepth?: number;
      includePattern?: string;
    };
    const maxPages = Math.min(config.maxPages ?? 50, 500);
    const maxDepth = Math.min(config.maxDepth ?? 2, 5);
    const include = config.includePattern ? new RegExp(config.includePattern) : null;

    const origin = new URL(source.location).origin;
    const seen = new Set<string>([source.location]);
    const queue: { url: string; depth: number }[] = [{ url: source.location, depth: 0 }];
    let added = 0;
    let updated = 0;
    let failed = 0;

    while (queue.length && seen.size <= maxPages) {
      const { url, depth } = queue.shift()!;
      try {
        const parsed = await this.fetchUrl(url);
        if (!parsed.text.trim()) continue;

        const contentHash = this.crypto.contentHash(parsed.text);
        const existing = await this.prisma.db.document.findFirst({ where: { sourceId, uri: url } });

        if (existing) {
          // Unchanged pages are skipped entirely — re-embedding them is pure cost.
          if (existing.contentHash === contentHash) continue;
          await this.prisma.db.document.update({
            where: { id: existing.id },
            data: {
              text: parsed.text,
              contentHash,
              title: parsed.title ?? existing.title,
              status: 'processing',
              version: { increment: 1 },
            },
          });
          await this.rag.indexChunks(
            existing.id,
            source.knowledgeBaseId,
            chunkDocument(parsed.text),
          );
          updated += 1;
        } else {
          const document = await this.prisma.db.document.create({
            data: {
              id: newId('document'),
              knowledgeBaseId: source.knowledgeBaseId,
              sourceId,
              title: parsed.title ?? url,
              type: 'website',
              uri: url,
              text: parsed.text,
              contentHash,
              status: 'processing',
            } as never,
          });
          await this.rag.indexChunks(
            document.id,
            source.knowledgeBaseId,
            chunkDocument(parsed.text),
          );
          added += 1;
        }

        if (depth < maxDepth) {
          for (const link of extractLinks(parsed.text, url, origin)) {
            if (seen.size >= maxPages) break;
            if (seen.has(link) || (include && !include.test(link))) continue;
            seen.add(link);
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      } catch (error) {
        failed += 1;
        this.logger.debug('Crawl page failed', { url, reason: String(error) });
      }
    }

    await this.prisma.db.knowledgeSource.update({
      where: { id: sourceId },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: `added ${added}, updated ${updated}, failed ${failed}`,
      },
    });
    await this.events.publish(
      DomainEvent.KnowledgeSourceSynced,
      { type: 'source', id: sourceId },
      { sourceId, added, updated, removed: 0 },
    );

    return { added, updated, failed };
  }
}

/** Same-origin links only; a crawl must not wander off the configured site. */
function extractLinks(text: string, base: string, origin: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    try {
      const url = new URL(match[0], base);
      url.hash = '';
      if (url.origin === origin) links.add(url.toString());
    } catch {
      // Ignore anything that is not a usable URL.
    }
  }
  return [...links];
}

function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.local')
  )
    return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower)) {
    const [a, b] = lower.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // IPv6 loopback and unique-local addresses.
  return (
    lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')
  );
}
