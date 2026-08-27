import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../core/errors/app-error';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CallsService } from './calls.service';
import { IvrService } from './ivr.service';
import { SpeechGateway } from './speech.gateway';
import { TelephonyRegistry } from './telephony-registry.service';
import { VoiceAgentService } from './voice-agent.service';
import type { TelephonyProviderKey } from './telephony-adapter';

const E164 = /^\+[1-9]\d{6,14}$/;

const PhoneNumberSchema = z
  .object({
    number: z.string().regex(E164, 'A phone number must be in E.164 form, e.g. +962790001234'),
    label: z.string().max(80).optional(),
    provider: z.enum(['simulated', 'twilio', 'sip']),
    routeType: z.enum(['ivr', 'queue', 'agent', 'ai_agent', 'voicemail']),
    routeId: z.string().optional(),
    afterHoursRouteType: z.enum(['ivr', 'queue', 'agent', 'ai_agent', 'voicemail']).optional(),
    afterHoursRouteId: z.string().optional(),
    businessHoursId: z.string().optional(),
    recordCalls: z.boolean().optional(),
    channelAccountId: z.string().optional(),
    workspaceId: z.string().optional(),
    capabilities: z.array(z.string().max(20)).max(10).optional(),
  })
  .strict();

const IvrFlowSchema = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(500).optional(),
    locale: z.string().max(10).optional(),
    definition: z.object({ entry: z.string(), nodes: z.record(z.any()) }),
  })
  .strict();

const TransferSchema = z
  .object({
    userId: z.string().optional(),
    queueId: z.string().optional(),
    number: z.string().regex(E164).optional(),
  })
  .strict();

const OriginateSchema = z
  .object({
    from: z.string().regex(E164),
    to: z.string().regex(E164),
    userId: z.string().optional(),
    customerId: z.string().optional(),
  })
  .strict();

const SaySchema = z.object({ text: z.string().min(1).max(2000) }).strict();

const TurnSchema = z
  .object({
    text: z.string().max(4000).optional(),
    /** Base64 audio, for providers that hand the platform the media. */
    audio: z.string().max(8_000_000).optional(),
    contentType: z.string().max(80).optional(),
    timedOut: z.boolean().optional(),
  })
  .strict();

@ApiTags('Voice')
@Controller('voice')
export class VoiceController {
  constructor(
    private readonly calls: CallsService,
    private readonly ivr: IvrService,
    private readonly agent: VoiceAgentService,
    private readonly registry: TelephonyRegistry,
    private readonly speech: SpeechGateway,
  ) {}

  // ── Provider webhooks ──────────────────────────────────────────────────────

  /**
   * Unauthenticated by necessity — a carrier cannot hold a platform token.
   * Authenticity comes from the provider's own signature, which the adapter
   * verifies before a single byte of the payload is acted on.
   */
  @Public()
  @Post('webhooks/:provider')
  @ApiOperation({ summary: 'Receive a telephony provider callback' })
  async webhook(
    @Param('provider') provider: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    if (!['simulated', 'twilio', 'sip'].includes(provider))
      throw AppError.notFound('Telephony provider', provider);

    const result = await this.calls.handleWebhook(
      provider as TelephonyProviderKey,
      body,
      headers,
      typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {}),
    );

    // The provider drives the call from this response, so it is sent raw: a
    // TwiML document inside a JSON envelope is not a call flow, it is a 500.
    return reply
      .header('content-type', result.contentType ?? 'application/json')
      .send(result.body ?? (result.contentType?.includes('xml') ? '<Response/>' : {}));
  }

  // ── Live calls ─────────────────────────────────────────────────────────────

  @Get('calls')
  @RequirePermissions('call:read')
  @ApiOperation({ summary: 'List calls' })
  list(@Query('status') status?: string, @Query('queueId') queueId?: string) {
    return this.calls.list({ status: status as never, queueId });
  }

  @Get('calls/live')
  @RequirePermissions('call:read')
  @ApiOperation({ summary: 'Calls in progress right now' })
  live() {
    return this.calls.live();
  }

  @Get('calls/:callId')
  @RequirePermissions('call:read')
  @ApiOperation({ summary: 'A call with its events, transcript, participants and recordings' })
  get(@Param('callId') callId: string) {
    return this.calls.get(callId);
  }

  @Post('calls')
  @RequirePermissions('call:control')
  @ApiOperation({ summary: 'Place an outbound call' })
  originate(@Body(zodBody(OriginateSchema)) body: z.infer<typeof OriginateSchema>) {
    return this.calls.originate(body);
  }

  @Post('calls/:callId/hold')
  @RequirePermissions('call:control')
  @ApiOperation({ summary: 'Put the caller on hold' })
  hold(@Param('callId') callId: string) {
    return this.calls.hold(callId);
  }

  @Post('calls/:callId/resume')
  @RequirePermissions('call:control')
  @ApiOperation({ summary: 'Take the caller off hold' })
  resume(@Param('callId') callId: string) {
    return this.calls.resume(callId);
  }

  @Post('calls/:callId/transfer')
  @RequirePermissions('call:control')
  @ApiOperation({ summary: 'Transfer to a person, a queue or an outside number' })
  transfer(
    @Param('callId') callId: string,
    @Body(zodBody(TransferSchema)) body: z.infer<typeof TransferSchema>,
  ) {
    return this.calls.transfer(callId, body);
  }

  @Post('calls/:callId/say')
  @RequirePermissions('call:control')
  @ApiOperation({ summary: 'Speak to the caller' })
  say(@Param('callId') callId: string, @Body(zodBody(SaySchema)) body: z.infer<typeof SaySchema>) {
    return this.calls.say(callId, body.text);
  }

  @Post('calls/:callId/hangup')
  @RequirePermissions('call:control')
  @ApiOperation({ summary: 'End the call' })
  hangup(@Param('callId') callId: string) {
    return this.calls.hangup(callId);
  }

  @Get('calls/:callId/recordings/:recordingId')
  @RequirePermissions('call:read')
  @ApiOperation({ summary: 'Download a recording from the platform’s own store' })
  async recording(
    @Param('callId') callId: string,
    @Param('recordingId') recordingId: string,
    @Res() reply: FastifyReply,
  ) {
    const { content, contentType, filename } = await this.calls.recordingContent(
      callId,
      recordingId,
    );
    return reply
      .header('content-type', contentType)
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(content);
  }

  // ── AI voice agent ─────────────────────────────────────────────────────────

  @Post('calls/:callId/turn')
  @RequirePermissions('call:control')
  @ApiOperation({ summary: 'Run one AI voice turn against what the caller just said' })
  turn(
    @Param('callId') callId: string,
    @Body(zodBody(TurnSchema)) body: z.infer<typeof TurnSchema>,
  ) {
    return this.agent.turn(callId, {
      text: body.text,
      audio: body.audio ? Buffer.from(body.audio, 'base64') : undefined,
      contentType: body.contentType,
      timedOut: body.timedOut,
    });
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  @Get('providers')
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'Telephony and speech providers this deployment can serve' })
  providers() {
    return { telephony: this.registry.available(), speech: this.speech.providers() };
  }

  @Get('numbers')
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'List phone numbers' })
  numbers() {
    return this.ivr.listNumbers();
  }

  @Post('numbers')
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'Add a phone number and say what answers it' })
  addNumber(@Body(zodBody(PhoneNumberSchema)) body: z.infer<typeof PhoneNumberSchema>) {
    return this.ivr.createNumber(body);
  }

  @Patch('numbers/:numberId')
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'Update a phone number' })
  updateNumber(
    @Param('numberId') numberId: string,
    @Body(zodBody(PhoneNumberSchema.partial())) body: Partial<z.infer<typeof PhoneNumberSchema>>,
  ) {
    return this.ivr.updateNumber(numberId, body);
  }

  @Delete('numbers/:numberId')
  @HttpCode(204)
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'Release a phone number' })
  async deleteNumber(@Param('numberId') numberId: string) {
    await this.ivr.deleteNumber(numberId);
  }

  @Get('ivr')
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'List IVR flows' })
  listFlows() {
    return this.ivr.listFlows();
  }

  @Post('ivr')
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'Create an IVR flow; a flow that cannot be walked is refused' })
  createFlow(@Body(zodBody(IvrFlowSchema)) body: z.infer<typeof IvrFlowSchema>) {
    return this.ivr.createFlow(body as never);
  }

  @Get('ivr/:flowId')
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'Get an IVR flow' })
  getFlow(@Param('flowId') flowId: string) {
    return this.ivr.getFlow(flowId);
  }

  @Patch('ivr/:flowId')
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'Update an IVR flow' })
  updateFlow(
    @Param('flowId') flowId: string,
    @Body(zodBody(IvrFlowSchema.partial())) body: Partial<z.infer<typeof IvrFlowSchema>>,
  ) {
    return this.ivr.updateFlow(flowId, body as never);
  }

  @Post('ivr/:flowId/activate')
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'Make this the flow inbound calls enter' })
  activateFlow(@Param('flowId') flowId: string) {
    return this.ivr.setActive(flowId, true);
  }

  @Post('ivr/:flowId/simulate')
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'Walk a flow with a sequence of keypresses, without a call' })
  simulate(
    @Param('flowId') flowId: string,
    @Body(zodBody(z.object({ digits: z.array(z.string().max(20)).max(20) }).strict()))
    body: { digits: string[] },
  ) {
    return this.ivr.simulate(flowId, body.digits);
  }

  @Delete('ivr/:flowId')
  @HttpCode(204)
  @RequirePermissions('voice:manage')
  @ApiOperation({ summary: 'Delete an IVR flow' })
  async deleteFlow(@Param('flowId') flowId: string) {
    await this.ivr.deleteFlow(flowId);
  }
}
