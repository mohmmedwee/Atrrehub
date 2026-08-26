import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ChannelsService } from './channels.service';

const ChannelEnum = z.enum([
  'web_chat',
  'email',
  'voice',
  'whatsapp',
  'sms',
  'telegram',
  'messenger',
  'instagram',
  'teams',
  'api',
]);

const AccountSchema = z
  .object({
    channel: ChannelEnum,
    name: z.string().min(2).max(80),
    credentials: z.record(z.unknown()).optional(),
    config: z.record(z.unknown()).optional(),
    queueId: z.string().optional(),
    workspaceId: z.string().optional(),
  })
  .strict();

const UpdateAccountSchema = z
  .object({
    name: z.string().min(2).max(80).optional(),
    credentials: z.record(z.unknown()).optional(),
    config: z.record(z.unknown()).optional(),
    queueId: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const IngestSchema = z
  .object({
    channel: ChannelEnum,
    accountId: z.string().optional(),
    payload: z.record(z.unknown()),
  })
  .strict();

@ApiTags('Channels')
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'Channels this deployment can serve, with capabilities' })
  available() {
    return this.channels.available();
  }

  @Get('accounts')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'List channel accounts' })
  listAccounts() {
    return this.channels.listAccounts();
  }

  @Post('accounts')
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Connect a channel account' })
  createAccount(@Body(zodBody(AccountSchema)) body: z.infer<typeof AccountSchema>) {
    return this.channels.createAccount(body as never);
  }

  @Patch('accounts/:id')
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Update a channel account' })
  updateAccount(
    @Param('id') id: string,
    @Body(zodBody(UpdateAccountSchema)) body: z.infer<typeof UpdateAccountSchema>,
  ) {
    return this.channels.updateAccount(id, body);
  }

  @Delete('accounts/:id')
  @HttpCode(204)
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Disconnect a channel account' })
  async deleteAccount(@Param('id') id: string) {
    await this.channels.deleteAccount(id);
  }

  @Post('ingest')
  @RequirePermissions('conversation:create')
  @ApiOperation({ summary: 'Ingest an inbound provider payload' })
  ingest(@Body(zodBody(IngestSchema)) body: z.infer<typeof IngestSchema>) {
    return this.channels.ingest(body.channel, body.payload, body.accountId);
  }
}
