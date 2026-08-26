import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CursorQuery } from '../../common/pagination';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { TicketsService } from './tickets.service';

const PriorityEnum = z.enum(['low', 'normal', 'high', 'urgent', 'critical']);
const StatusEnum = z.enum(['open', 'pending', 'on_hold', 'resolved', 'closed', 'reopened']);

const CreateSchema = z
  .object({
    subject: z.string().min(2).max(300),
    description: z.string().max(50_000).optional(),
    customerId: z.string().optional(),
    conversationId: z.string().optional(),
    priority: PriorityEnum.optional(),
    category: z.string().max(80).optional(),
    assigneeId: z.string().optional(),
    teamId: z.string().optional(),
    queueId: z.string().optional(),
    labels: z.array(z.string().max(40)).max(30).optional(),
    customFields: z.record(z.unknown()).optional(),
    dueAt: z.coerce.date().optional(),
    workspaceId: z.string().optional(),
  })
  .strict();

const UpdateSchema = CreateSchema.partial().extend({ status: StatusEnum.optional() }).strict();

const ListQuery = CursorQuery.extend({
  status: z.string().max(120).optional(),
  priority: z.string().max(60).optional(),
  category: z.string().max(80).optional(),
  assigneeId: z.string().optional(),
  teamId: z.string().optional(),
  queueId: z.string().optional(),
  customerId: z.string().optional(),
  open: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(),
  q: z.string().max(160).optional(),
  sort: z.string().max(80).optional(),
  labels: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((t) => t.trim()).filter(Boolean) : undefined)),
});

const BulkSchema = z
  .object({
    ticketIds: z.array(z.string()).min(1).max(500),
    patch: UpdateSchema,
  })
  .strict();

const CommentSchema = z.object({ body: z.string().min(1).max(50_000), isInternal: z.boolean().optional() }).strict();

const TemplateSchema = z
  .object({
    name: z.string().min(2).max(80),
    subject: z.string().min(2).max(300),
    description: z.string().max(50_000).optional(),
    priority: PriorityEnum.optional(),
    category: z.string().max(80).optional(),
    labels: z.array(z.string().max(40)).max(30).optional(),
    customFields: z.record(z.unknown()).optional(),
  })
  .strict();

@ApiTags('Ticketing')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @RequirePermissions('ticket:read')
  @ApiOperation({ summary: 'List and filter tickets' })
  list(@Query(zodQuery(ListQuery)) query: z.infer<typeof ListQuery>) {
    return this.tickets.list(query);
  }

  @Post()
  @RequirePermissions('ticket:create')
  @ApiOperation({ summary: 'Create a ticket' })
  create(@Body(zodBody(CreateSchema)) body: z.infer<typeof CreateSchema>) {
    return this.tickets.create(body as never);
  }

  @Get('templates')
  @RequirePermissions('ticket:read')
  @ApiOperation({ summary: 'List ticket templates' })
  listTemplates() {
    return this.tickets.listTemplates();
  }

  @Post('templates')
  @RequirePermissions('ticket:update')
  @ApiOperation({ summary: 'Create a ticket template' })
  createTemplate(@Body(zodBody(TemplateSchema)) body: z.infer<typeof TemplateSchema>) {
    return this.tickets.createTemplate(body);
  }

  @Delete('templates/:id')
  @HttpCode(204)
  @RequirePermissions('ticket:update')
  @ApiOperation({ summary: 'Delete a ticket template' })
  async deleteTemplate(@Param('id') id: string) {
    await this.tickets.deleteTemplate(id);
  }

  @Post('templates/:id/instantiate')
  @RequirePermissions('ticket:create')
  @ApiOperation({ summary: 'Create a ticket from a template' })
  fromTemplate(@Param('id') id: string, @Body(zodBody(CreateSchema.partial())) body: Record<string, unknown>) {
    return this.tickets.createFromTemplate(id, body);
  }

  @Post('from-conversation/:conversationId')
  @RequirePermissions('ticket:create')
  @ApiOperation({ summary: 'Open a ticket from a conversation, carrying its context' })
  fromConversation(
    @Param('conversationId') conversationId: string,
    @Body(zodBody(CreateSchema.partial())) body: Record<string, unknown>,
  ) {
    return this.tickets.createFromConversation(conversationId, body);
  }

  @Post('bulk')
  @RateLimit(RATE_BUCKETS.bulk)
  @RequirePermissions('ticket:update')
  @ApiOperation({ summary: 'Apply one change set to many tickets' })
  bulk(@Body(zodBody(BulkSchema)) body: z.infer<typeof BulkSchema>) {
    return this.tickets.bulkUpdate(body.ticketIds, body.patch as never);
  }

  @Get(':id')
  @RequirePermissions('ticket:read')
  @ApiOperation({ summary: 'Read a ticket' })
  get(@Param('id') id: string) {
    return this.tickets.get(id);
  }

  @Patch(':id')
  @RequirePermissions('ticket:update')
  @ApiOperation({ summary: 'Update a ticket; send If-Match for optimistic locking' })
  update(
    @Param('id') id: string,
    @Body(zodBody(UpdateSchema)) body: z.infer<typeof UpdateSchema>,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch ? Number(ifMatch.replace(/"/g, '')) : undefined;
    return this.tickets.update(id, body as never, Number.isFinite(expectedVersion) ? expectedVersion : undefined);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('ticket:delete')
  @ApiOperation({ summary: 'Delete a ticket' })
  async delete(@Param('id') id: string) {
    await this.tickets.delete(id);
  }

  @Get(':id/comments')
  @RequirePermissions('ticket:read')
  @ApiOperation({ summary: 'List ticket comments' })
  comments(@Param('id') id: string) {
    return this.tickets.listComments(id);
  }

  @Post(':id/comments')
  @RequirePermissions('ticket:update')
  @ApiOperation({ summary: 'Add a comment' })
  addComment(@Param('id') id: string, @Body(zodBody(CommentSchema)) body: z.infer<typeof CommentSchema>) {
    return this.tickets.addComment(id, body.body, body.isInternal);
  }

  @Get(':id/history')
  @RequirePermissions('ticket:read')
  @ApiOperation({ summary: 'Field-level ticket history' })
  history(@Param('id') id: string) {
    return this.tickets.history(id);
  }
}
