import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { Public } from '../auth/decorators/public.decorator';
import { WidgetService } from './widget.service';

const MessageSchema = z
  .object({
    sessionId: z.string().min(6).max(80),
    body: z.string().min(1).max(4000),
    conversationId: z.string().optional(),
    email: z.string().email().optional(),
    displayName: z.string().max(120).optional(),
    locale: z.string().max(10).optional(),
  })
  .strict();

/**
 * The public surface the embedded chat widget talks to.
 *
 * Authentication is by widget key, and every route is scoped to the visitor's
 * own session — a widget can only ever see the conversation it started.
 */
@ApiTags('Widget')
@Controller('widget')
@RateLimit(RATE_BUCKETS.widget)
export class WidgetController {
  constructor(private readonly widget: WidgetService) {}

  @Public()
  @Post('messages')
  @ApiOperation({ summary: 'Send a message from the chat widget' })
  async send(
    @Headers('x-widget-key') widgetKey: string | undefined,
    @Body(zodBody(MessageSchema)) body: z.infer<typeof MessageSchema>,
  ) {
    const account = await this.widget.resolveAccount(widgetKey);
    return RequestContextStore.runAsSystem(() => this.widget.receive(account, body), account.organizationId);
  }

  @Public()
  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'Poll the visitor’s own conversation' })
  async messages(
    @Headers('x-widget-key') widgetKey: string | undefined,
    @Headers('x-widget-session') sessionId: string | undefined,
    @Param('id') conversationId: string,
  ) {
    if (!sessionId) throw AppError.unauthenticated('A widget session is required');
    const account = await this.widget.resolveAccount(widgetKey);
    return RequestContextStore.runAsSystem(
      () => this.widget.transcript(conversationId, sessionId),
      account.organizationId,
    );
  }

  @Public()
  @Get('config')
  @ApiOperation({ summary: 'Branding and greeting for the widget' })
  async config(@Headers('x-widget-key') widgetKey: string | undefined) {
    const account = await this.widget.resolveAccount(widgetKey);
    return RequestContextStore.runAsSystem(() => this.widget.config(account), account.organizationId);
  }
}
