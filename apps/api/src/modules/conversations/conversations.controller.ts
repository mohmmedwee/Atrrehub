import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CursorQuery } from '../../common/pagination';
import type { Principal } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ChannelsService } from '../channels/channels.service';
import { ConversationsService } from './conversations.service';

const ListQuery = CursorQuery.extend({
  status: z.string().max(120).optional(),
  channel: z.string().max(120).optional(),
  priority: z.string().max(60).optional(),
  queueId: z.string().optional(),
  assigneeId: z.string().optional(),
  customerId: z.string().optional(),
  unassigned: z.coerce.boolean().optional(),
  q: z.string().max(160).optional(),
  sort: z.string().max(80).optional(),
  tags: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((t) => t.trim()).filter(Boolean) : undefined)),
});

const CreateSchema = z
  .object({
    channel: z.enum(['web_chat', 'email', 'voice', 'whatsapp', 'sms', 'telegram', 'messenger', 'instagram', 'teams', 'api']),
    customerId: z.string().optional(),
    subject: z.string().max(300).optional(),
    queueId: z.string().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent', 'critical']).optional(),
    locale: z.string().max(10).optional(),
    tags: z.array(z.string().max(40)).max(30).optional(),
    workspaceId: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const UpdateSchema = z
  .object({
    subject: z.string().max(300).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent', 'critical']).optional(),
    tags: z.array(z.string().max(40)).max(30).optional(),
    locale: z.string().max(10).optional(),
  })
  .strict();

const StatusSchema = z
  .object({
    status: z.enum(['new', 'queued', 'assigned', 'active', 'waiting', 'resolved', 'closed']),
    reason: z.string().max(200).optional(),
  })
  .strict();

const AssignSchema = z
  .object({
    assigneeType: z.enum(['user', 'ai_agent', 'none']),
    assigneeId: z.string().optional(),
    queueId: z.string().optional(),
    reason: z.string().max(200).optional(),
  })
  .strict()
  .refine((value) => value.assigneeType === 'none' || !!value.assigneeId, {
    message: 'assigneeId is required unless unassigning',
    path: ['assigneeId'],
  });

const TransferSchema = z
  .object({
    userId: z.string().optional(),
    teamId: z.string().optional(),
    queueId: z.string().optional(),
    reason: z.string().max(200).optional(),
  })
  .strict()
  .refine((value) => !!(value.userId || value.teamId || value.queueId), {
    message: 'Provide a destination user, team or queue',
  });

const ReplySchema = z
  .object({
    body: z.string().min(1).max(20_000),
    bodyHtml: z.string().max(200_000).optional(),
    citations: z.array(z.unknown()).max(50).optional(),
  })
  .strict();

const NoteSchema = z.object({ body: z.string().min(1).max(20_000) }).strict();
const CsatSchema = z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() }).strict();

@ApiTags('Conversations')
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly channels: ChannelsService,
  ) {}

  @Get()
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'List conversations' })
  list(@Query(zodQuery(ListQuery)) query: z.infer<typeof ListQuery>) {
    return this.conversations.list(query);
  }

  @Get('inbox')
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'The signed-in agent’s inbox' })
  inbox(@CurrentUser() principal: Principal | undefined, @Query(zodQuery(ListQuery)) query: z.infer<typeof ListQuery>) {
    if (principal?.type !== 'user') throw AppError.permissionDenied('The inbox requires a user session');
    return this.conversations.inbox(principal.id, query);
  }

  @Get('queue-stats')
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'Live queue depth and oldest wait' })
  queueStats() {
    return this.conversations.queueStats();
  }

  @Post()
  @RequirePermissions('conversation:create')
  @ApiOperation({ summary: 'Open a conversation' })
  create(@Body(zodBody(CreateSchema)) body: z.infer<typeof CreateSchema>) {
    return this.conversations.create(body as never);
  }

  @Get(':id')
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'Read a conversation' })
  get(@Param('id') id: string) {
    return this.conversations.get(id);
  }

  @Patch(':id')
  @RequirePermissions('conversation:update')
  @ApiOperation({ summary: 'Update subject, priority, tags or locale' })
  update(@Param('id') id: string, @Body(zodBody(UpdateSchema)) body: z.infer<typeof UpdateSchema>) {
    return this.conversations.update(id, body);
  }

  @Get(':id/messages')
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'List messages' })
  messages(@Param('id') id: string, @Query(zodQuery(CursorQuery)) query: z.infer<typeof CursorQuery>) {
    return this.conversations.listMessages(id, query);
  }

  @Post(':id/messages')
  @RequirePermissions('message:create')
  @ApiOperation({ summary: 'Reply to the customer through the conversation’s channel' })
  reply(
    @CurrentUser() principal: Principal | undefined,
    @Param('id') id: string,
    @Body(zodBody(ReplySchema)) body: z.infer<typeof ReplySchema>,
  ) {
    return this.channels.sendReply({
      conversationId: id,
      body: body.body,
      bodyHtml: body.bodyHtml,
      citations: body.citations,
      authorType: 'user',
      authorId: principal?.id,
      authorName: principal?.label,
    });
  }

  @Post(':id/notes')
  @RequirePermissions('message:create')
  @ApiOperation({ summary: 'Add an internal note, never sent to the customer' })
  note(@Param('id') id: string, @Body(zodBody(NoteSchema)) body: z.infer<typeof NoteSchema>) {
    return this.conversations.addInternalNote(id, body.body);
  }

  @Post(':id/status')
  @RequirePermissions('conversation:update')
  @ApiOperation({ summary: 'Move the conversation through its lifecycle' })
  setStatus(@Param('id') id: string, @Body(zodBody(StatusSchema)) body: z.infer<typeof StatusSchema>) {
    return this.conversations.setStatus(id, body.status, body.reason);
  }

  @Post(':id/assign')
  @RequirePermissions('conversation:assign')
  @ApiOperation({ summary: 'Assign to an agent or AI agent, or return to the queue' })
  assign(@Param('id') id: string, @Body(zodBody(AssignSchema)) body: z.infer<typeof AssignSchema>) {
    return this.conversations.assign(
      id,
      body.assigneeType === 'none' ? null : { type: body.assigneeType, id: body.assigneeId! },
      { reason: body.reason, queueId: body.queueId },
    );
  }

  @Post(':id/transfer')
  @RequirePermissions('conversation:assign')
  @ApiOperation({ summary: 'Transfer to another agent, team or queue' })
  transfer(@Param('id') id: string, @Body(zodBody(TransferSchema)) body: z.infer<typeof TransferSchema>) {
    return this.conversations.transfer(id, body, body.reason);
  }

  @Get(':id/history')
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'Conversation audit history' })
  history(@Param('id') id: string) {
    return this.conversations.history(id);
  }

  @Post(':id/csat')
  @HttpCode(200)
  @RequirePermissions('conversation:update')
  @ApiOperation({ summary: 'Record a satisfaction score' })
  csat(@Param('id') id: string, @Body(zodBody(CsatSchema)) body: z.infer<typeof CsatSchema>) {
    return this.conversations.submitCsat(id, body.score, body.comment);
  }
}
