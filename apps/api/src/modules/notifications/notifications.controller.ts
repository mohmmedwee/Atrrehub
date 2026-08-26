import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CursorQuery } from '../../common/pagination';
import type { Principal } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { NotificationsService } from './notifications.service';

const ChannelEnum = z.enum(['email', 'sms', 'push', 'in_app', 'webhook']);

const AudienceSchema = z
  .object({
    roles: z.array(z.string().max(40)).max(20).optional(),
    userIds: z.array(z.string()).max(200).optional(),
    teamIds: z.array(z.string()).max(50).optional(),
    assignee: z.boolean().optional(),
    addresses: z.array(z.string().email()).max(20).optional(),
    webhookUrl: z.string().url().optional(),
  })
  .strict();

const RuleSchema = z
  .object({
    name: z.string().min(2).max(80),
    event: z.string().min(3).max(60),
    channels: z.array(ChannelEnum).min(1).max(5),
    audience: AudienceSchema,
    template: z.string().max(500).optional(),
    conditions: z.object({ expression: z.string().max(1000).optional() }).optional(),
  })
  .strict();

const InboxQuery = CursorQuery.extend({ unreadOnly: z.coerce.boolean().optional() });

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('events')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'Events a notification rule can subscribe to' })
  catalog() {
    return this.notifications.catalog();
  }

  @Get('rules')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'List notification rules' })
  listRules() {
    return this.notifications.listRules();
  }

  @Post('rules')
  @RequirePermissions('notification:manage')
  @ApiOperation({ summary: 'Create a notification rule' })
  createRule(@Body(zodBody(RuleSchema)) body: z.infer<typeof RuleSchema>) {
    return this.notifications.createRule(body as never);
  }

  @Patch('rules/:id')
  @RequirePermissions('notification:manage')
  @ApiOperation({ summary: 'Update a notification rule' })
  updateRule(
    @Param('id') id: string,
    @Body(zodBody(RuleSchema.partial())) body: Record<string, unknown>,
  ) {
    return this.notifications.updateRule(id, body);
  }

  @Delete('rules/:id')
  @HttpCode(204)
  @RequirePermissions('notification:manage')
  @ApiOperation({ summary: 'Delete a notification rule' })
  async deleteRule(@Param('id') id: string) {
    await this.notifications.deleteRule(id);
  }

  @Get()
  @ApiOperation({ summary: 'The signed-in user’s notification inbox' })
  inbox(
    @CurrentUser() principal: Principal | undefined,
    @Query(zodQuery(InboxQuery)) query: z.infer<typeof InboxQuery>,
  ) {
    return this.notifications.inbox(this.requireUser(principal), query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread notification count, for the badge' })
  async unreadCount(@CurrentUser() principal: Principal | undefined) {
    return { count: await this.notifications.unreadCount(this.requireUser(principal)) };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one notification as read' })
  markRead(@CurrentUser() principal: Principal | undefined, @Param('id') id: string) {
    return this.notifications.markRead(this.requireUser(principal), id);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark every notification as read' })
  async markAllRead(@CurrentUser() principal: Principal | undefined) {
    return { marked: await this.notifications.markAllRead(this.requireUser(principal)) };
  }

  @Post('test')
  @RequirePermissions('notification:manage')
  @ApiOperation({ summary: 'Fire an event through the rules to verify delivery' })
  async test(
    @Body(
      zodBody(
        z
          .object({ event: z.string().min(3).max(60), context: z.record(z.unknown()).default({}) })
          .strict(),
      ),
    )
    body: {
      event: string;
      context: Record<string, unknown>;
    },
  ) {
    return { delivered: await this.notifications.dispatch(body.event, body.context) };
  }

  /** The inbox belongs to a person; an API key has no inbox to read. */
  private requireUser(principal: Principal | undefined): string {
    if (principal?.type !== 'user') {
      throw AppError.permissionDenied('Notifications require an interactive user session');
    }
    return principal.id;
  }
}
