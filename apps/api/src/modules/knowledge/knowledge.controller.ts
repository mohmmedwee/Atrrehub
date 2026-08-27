import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CursorQuery } from '../../common/pagination';
import { AppError } from '../../core/errors/app-error';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { ApiOptionalQuery, ApiZodBody, ApiZodQuery } from '../../core/http/zod-openapi';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { RagService } from '../rag/rag.service';
import { KnowledgeService } from './knowledge.service';

const BaseSchema = z
  .object({
    name: z.string().min(2).max(120),
    key: z
      .string()
      .min(2)
      .max(60)
      .regex(/^[a-z][a-z0-9_-]*$/),
    description: z.string().max(500).optional(),
    locale: z.string().max(10).optional(),
    readRoles: z.array(z.string().max(40)).max(20).optional(),
    isPublic: z.boolean().optional(),
    workspaceId: z.string().optional(),
  })
  .strict();

const ArticleSchema = z
  .object({
    knowledgeBaseId: z.string().min(3),
    title: z.string().min(2).max(300),
    body: z.string().min(1).max(500_000),
    summary: z.string().max(2000).optional(),
    slug: z.string().max(80).optional(),
    categoryId: z.string().optional(),
    locale: z.string().max(10).optional(),
    tags: z.array(z.string().max(40)).max(30).optional(),
    keywords: z.array(z.string().max(60)).max(50).optional(),
  })
  .strict();

const UpdateArticleSchema = ArticleSchema.partial()
  .omit({ knowledgeBaseId: true })
  .extend({ changeNote: z.string().max(300).optional() })
  .strict();

const CategorySchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().max(80).optional(),
    parentId: z.string().optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .strict();

const SourceSchema = z
  .object({
    knowledgeBaseId: z.string().min(3),
    type: z.enum(['article', 'file', 'url', 'website', 'faq', 'api', 'cloud_storage']),
    name: z.string().min(2).max(120),
    location: z.string().url().optional(),
    config: z.record(z.unknown()).optional(),
    syncCron: z.string().max(60).optional(),
  })
  .strict();

const UrlSchema = z
  .object({
    knowledgeBaseId: z.string().min(3),
    url: z.string().url(),
    locale: z.string().max(10).optional(),
  })
  .strict();

const SearchQuery = z.object({
  q: z.string().min(1).max(1000),
  knowledgeBaseIds: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    ),
  locale: z.string().max(10).optional(),
  topK: z.coerce.number().int().min(1).max(50).default(6),
  rerank: z.coerce.boolean().default(true),
});

@ApiTags('Knowledge & RAG')
@Controller('knowledge')
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly rag: RagService,
  ) {}

  // ── Search ──

  @Get('search')
  @RequirePermissions('knowledge:read')
  @RateLimit(RATE_BUCKETS.ai)
  @ApiOperation({ summary: 'Hybrid retrieval with citations' })
  @ApiZodQuery(SearchQuery)
  async search(@Query(zodQuery(SearchQuery)) query: z.infer<typeof SearchQuery>) {
    // Retrieval is confined to the bases this principal may read.
    const readable = await this.knowledge.readableBaseIds();
    const scope = query.knowledgeBaseIds?.length
      ? query.knowledgeBaseIds.filter((id) => readable.includes(id))
      : readable;

    const hits = await this.rag.retrieve(query.q, {
      knowledgeBaseIds: scope,
      locale: query.locale,
      topK: query.topK,
      rerank: query.rerank,
    });
    return { hits, ...this.rag.buildContext(hits) };
  }

  @Get('retrieval-stats')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Retrieval quality over a period' })
  retrievalStats(@Query('from') from: string, @Query('to') to: string) {
    return this.rag.retrievalStats({
      from: from ? new Date(from) : new Date(Date.now() - 7 * 86_400_000),
      to: to ? new Date(to) : new Date(),
    });
  }

  // ── Knowledge bases ──

  @Get('bases')
  @RequirePermissions('knowledge:read')
  @ApiOperation({ summary: 'List knowledge bases' })
  listBases() {
    return this.knowledge.listBases();
  }

  @Post('bases')
  @RequirePermissions('knowledge:create')
  @ApiOperation({ summary: 'Create a knowledge base' })
  @ApiZodBody(BaseSchema)
  createBase(@Body(zodBody(BaseSchema)) body: z.infer<typeof BaseSchema>) {
    return this.knowledge.createBase(body);
  }

  @Get('bases/:id')
  @RequirePermissions('knowledge:read')
  @ApiOperation({ summary: 'Read a knowledge base' })
  getBase(@Param('id') id: string) {
    return this.knowledge.getBase(id);
  }

  @Patch('bases/:id')
  @RequirePermissions('knowledge:update')
  @ApiOperation({ summary: 'Update a knowledge base' })
  @ApiZodBody(BaseSchema.partial())
  updateBase(
    @Param('id') id: string,
    @Body(zodBody(BaseSchema.partial())) body: Record<string, unknown>,
  ) {
    return this.knowledge.updateBase(id, body);
  }

  @Delete('bases/:id')
  @HttpCode(204)
  @RequirePermissions('knowledge:delete')
  @ApiOperation({ summary: 'Delete a knowledge base' })
  async deleteBase(@Param('id') id: string) {
    await this.knowledge.deleteBase(id);
  }

  @Post('bases/:id/categories')
  @RequirePermissions('knowledge:update')
  @ApiOperation({ summary: 'Create a category' })
  @ApiZodBody(CategorySchema)
  createCategory(
    @Param('id') id: string,
    @Body(zodBody(CategorySchema)) body: z.infer<typeof CategorySchema>,
  ) {
    return this.knowledge.createCategory(id, body);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  @RequirePermissions('knowledge:update')
  @ApiOperation({ summary: 'Delete a category' })
  async deleteCategory(@Param('id') id: string) {
    await this.knowledge.deleteCategory(id);
  }

  // ── Articles ──

  @Get('articles')
  @RequirePermissions('knowledge:read')
  @ApiOperation({ summary: 'List articles' })
  listArticles(
    @Query(
      zodQuery(
        CursorQuery.extend({
          knowledgeBaseId: z.string().optional(),
          state: z.string().optional(),
          categoryId: z.string().optional(),
          q: z.string().max(160).optional(),
        }),
      ),
    )
    query: never,
  ) {
    return this.knowledge.listArticles(query);
  }

  @Post('articles')
  @RequirePermissions('knowledge:create')
  @ApiOperation({ summary: 'Create a draft article' })
  @ApiZodBody(ArticleSchema)
  createArticle(@Body(zodBody(ArticleSchema)) body: z.infer<typeof ArticleSchema>) {
    return this.knowledge.createArticle(body);
  }

  @Get('articles/:id')
  @RequirePermissions('knowledge:read')
  @ApiOperation({ summary: 'Read an article with its recent versions' })
  getArticle(@Param('id') id: string) {
    return this.knowledge.getArticle(id);
  }

  @Patch('articles/:id')
  @RequirePermissions('knowledge:update')
  @ApiOperation({ summary: 'Update an article, snapshotting the previous revision' })
  @ApiZodBody(UpdateArticleSchema)
  updateArticle(
    @Param('id') id: string,
    @Body(zodBody(UpdateArticleSchema)) body: z.infer<typeof UpdateArticleSchema>,
  ) {
    return this.knowledge.updateArticle(id, body);
  }

  @Post('articles/:id/publish')
  @RequirePermissions('knowledge:publish')
  @ApiOperation({ summary: 'Publish an article and index it for retrieval' })
  publishArticle(@Param('id') id: string) {
    return this.knowledge.publishArticle(id);
  }

  @Post('articles/:id/unpublish')
  @RequirePermissions('knowledge:publish')
  @ApiOperation({ summary: 'Unpublish an article and remove it from retrieval' })
  unpublishArticle(@Param('id') id: string) {
    return this.knowledge.unpublishArticle(id);
  }

  @Delete('articles/:id')
  @HttpCode(204)
  @RequirePermissions('knowledge:delete')
  @ApiOperation({ summary: 'Delete an article' })
  async deleteArticle(@Param('id') id: string) {
    await this.knowledge.deleteArticle(id);
  }

  // ── Documents ──

  @Get('documents')
  @RequirePermissions('knowledge:read')
  @ApiOperation({ summary: 'List documents and their ingestion status' })
  listDocuments(
    @Query(
      zodQuery(
        CursorQuery.extend({
          knowledgeBaseId: z.string().optional(),
          status: z.string().optional(),
        }),
      ),
    )
    query: never,
  ) {
    return this.knowledge.listDocuments(query);
  }

  @Post('documents/upload')
  @RequirePermissions('knowledge:create')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a document for ingestion' })
  async upload(@Req() request: FastifyRequest) {
    const file = await (
      request as unknown as {
        file: () => Promise<
          | {
              filename: string;
              mimetype: string;
              toBuffer: () => Promise<Buffer>;
              fields: Record<string, { value?: string }>;
            }
          | undefined
        >;
      }
    ).file();
    if (!file) throw AppError.badRequest('A file is required');

    const knowledgeBaseId = file.fields?.knowledgeBaseId?.value;
    if (!knowledgeBaseId) throw AppError.badRequest('knowledgeBaseId is required');

    return this.knowledge.uploadDocument({
      knowledgeBaseId,
      filename: file.filename,
      contentType: file.mimetype,
      content: await file.toBuffer(),
      locale: file.fields?.locale?.value,
      title: file.fields?.title?.value,
    });
  }

  @Post('documents/url')
  @RequirePermissions('knowledge:create')
  @ApiOperation({ summary: 'Ingest a URL' })
  @ApiZodBody(UrlSchema)
  ingestUrl(@Body(zodBody(UrlSchema)) body: z.infer<typeof UrlSchema>) {
    return this.knowledge.ingestUrl(body);
  }

  @Post('documents/:id/reindex')
  @RequirePermissions('knowledge:update')
  @RateLimit(RATE_BUCKETS.ai)
  @ApiOperation({ summary: 'Re-run ingestion for a document' })
  reindex(@Param('id') id: string) {
    return this.knowledge.processDocument(id);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @RequirePermissions('knowledge:delete')
  @ApiOperation({ summary: 'Delete a document and its chunks' })
  async deleteDocument(@Param('id') id: string) {
    await this.knowledge.deleteDocument(id);
  }

  // ── Sources ──

  @Get('sources')
  @RequirePermissions('knowledge:read')
  @ApiOperation({ summary: 'List knowledge sources' })
  @ApiOptionalQuery('knowledgeBaseId')
  listSources(@Query('knowledgeBaseId') knowledgeBaseId?: string) {
    return this.knowledge.listSources(knowledgeBaseId);
  }

  @Post('sources')
  @RequirePermissions('knowledge:create')
  @ApiOperation({ summary: 'Register a knowledge source' })
  @ApiZodBody(SourceSchema)
  createSource(@Body(zodBody(SourceSchema)) body: z.infer<typeof SourceSchema>) {
    return this.knowledge.createSource(body as never);
  }

  @Post('sources/:id/sync')
  @RequirePermissions('knowledge:update')
  @RateLimit(RATE_BUCKETS.bulk)
  @ApiOperation({ summary: 'Crawl and synchronize a source' })
  syncSource(@Param('id') id: string) {
    return this.knowledge.syncSource(id);
  }

  @Delete('sources/:id')
  @HttpCode(204)
  @RequirePermissions('knowledge:delete')
  @ApiOperation({ summary: 'Delete a knowledge source' })
  async deleteSource(@Param('id') id: string) {
    await this.knowledge.deleteSource(id);
  }
}
