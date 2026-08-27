import { Injectable } from '@nestjs/common';
import { Prisma, type CallDisposition, type CallStatus } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { MetricsService } from '../../core/metrics/metrics.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { StorageService } from '../../core/storage/storage.service';
import { ConversationsService } from '../conversations/conversations.service';
import { CustomersService } from '../customers/customers.service';
import { DirectoryService } from '../directory/directory.service';
import { RoutingService } from '../routing/routing.service';
import { initialState, step, validateIvr, type IvrDefinition, type IvrState } from './ivr';
import { TelephonyRegistry } from './telephony-registry.service';
import type { CallAction, NormalizedCallEvent, TelephonyProviderKey } from './telephony-adapter';

/**
 * The call lifecycle.
 *
 * Every call becomes a Conversation on the `voice` channel, so the workspace,
 * Customer 360, SLA clocks, routing, quality scoring and analytics all see a
 * call through exactly the record they already understand. The Call row holds
 * what is genuinely telephony — legs, digits, hold time, recordings — and
 * nothing that any other channel would also need.
 */

export interface InboundCallContext {
  provider: TelephonyProviderKey;
  accountId?: string;
}

/** Where a call is parked between webhooks, so the next one can resume it. */
interface CallControlState {
  ivr?: IvrState;
  ivrFlowId?: string;
  mode: 'ivr' | 'queue' | 'agent' | 'ai_agent' | 'voicemail' | 'ended';
  aiAgentId?: string;
}

@Injectable()
export class CallsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: TelephonyRegistry,
    private readonly conversations: ConversationsService,
    private readonly customers: CustomersService,
    private readonly routing: RoutingService,
    private readonly directory: DirectoryService,
    private readonly storage: StorageService,
    private readonly crypto: CryptoService,
    private readonly events: EventBus,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  // ── Inbound ────────────────────────────────────────────────────────────────

  /**
   * Handle a provider webhook.
   *
   * Returns whatever the provider should be answered with — a control document
   * for providers that drive the call from the webhook response, or nothing for
   * those where control is imperative.
   */
  async handleWebhook(
    provider: TelephonyProviderKey,
    payload: unknown,
    headers: Record<string, string | undefined>,
    rawBody?: string,
  ): Promise<{ body?: unknown; contentType?: string }> {
    const adapter = this.registry.adapter(provider);
    const account = await this.registry.accountFor(provider, payload);

    if (adapter.verifySignature && !adapter.verifySignature(payload, headers, account, rawBody)) {
      // A telephony webhook can move a live call and expose its recording, so
      // an unverified one is refused outright rather than merely logged.
      throw AppError.unauthenticated('The webhook signature does not verify');
    }

    const event = await adapter.receive(payload, account);
    if (!event) return {};

    return RequestContextStore.runAsSystem(
      () => this.applyEvent(provider, event),
      account.organizationId,
    );
  }

  private async applyEvent(
    provider: TelephonyProviderKey,
    event: NormalizedCallEvent,
  ): Promise<{ body?: unknown; contentType?: string }> {
    const call = await this.prisma.db.call.findFirst({
      where: { provider, providerCallId: event.providerCallId },
    });

    if (!call) {
      // Only the opening event of a call may create one; anything else naming
      // an unknown call is a stray retry or a spoofed id.
      if (event.type !== 'initiated' && event.type !== 'ringing' && event.type !== 'answered')
        return {};
      return this.beginInbound(provider, event);
    }

    await this.record(call.id, event.type, event.raw ?? {});

    switch (event.type) {
      case 'answered':
        return this.onAnswered(call.id);
      case 'dtmf':
        return this.onDigits(call.id, event.digits ?? '');
      case 'speech':
        return this.onSpeech(call.id, event.text ?? '');
      case 'recording_available':
        await this.storeRecording(call.id, provider, event);
        return {};
      case 'hangup':
        await this.end(call.id, { cause: event.cause, hangupBy: event.hangupBy ?? 'caller' });
        return {};
      case 'failed':
        await this.end(call.id, { cause: event.cause, status: 'failed', hangupBy: 'provider' });
        return {};
      default:
        return {};
    }
  }

  /** Create the call, its conversation and its customer, then answer it. */
  private async beginInbound(
    provider: TelephonyProviderKey,
    event: NormalizedCallEvent,
  ): Promise<{ body?: unknown; contentType?: string }> {
    const to = event.to ?? '';
    const from = event.from ?? '';

    const phoneNumber = await this.prisma.db.phoneNumber.findFirst({
      where: { number: to, isActive: true },
    });

    // A call to a number this tenant does not own is rejected politely rather
    // than answered: answering would bill the tenant for a wrong number.
    if (!phoneNumber) {
      const adapter = this.registry.adapter(provider);
      const account = await this.registry.accountFor(provider, event.raw);
      return adapter.control(
        event.providerCallId,
        [
          { kind: 'say', text: 'This number is not in service.' },
          { kind: 'hangup', cause: 'unallocated_number' },
        ],
        account,
      );
    }

    const { customer } = await this.customers.findOrCreateByContact('phone', from, {
      displayName: from,
    });

    const conversation = await this.conversations.create({
      channel: 'voice',
      customerId: customer.id,
      subject: `Call from ${from}`,
      workspaceId: phoneNumber.workspaceId ?? undefined,
      channelAccountId: phoneNumber.channelAccountId ?? undefined,
      externalId: event.providerCallId,
      threadKey: `call:${event.providerCallId}`,
      metadata: { direction: 'inbound', from, to },
    });

    const callId = newId('call');
    await this.prisma.db.call.create({
      data: {
        id: callId,
        organizationId: RequestContextStore.organizationId()!,
        workspaceId: phoneNumber.workspaceId,
        conversationId: conversation.id,
        phoneNumberId: phoneNumber.id,
        channelAccountId: phoneNumber.channelAccountId,
        customerId: customer.id,
        provider,
        providerCallId: event.providerCallId,
        direction: 'inbound',
        status: 'ringing',
        fromNumber: from,
        toNumber: to,
        isRecorded: phoneNumber.recordCalls,
      },
    });

    await this.record(callId, 'ringing', { from, to });
    // No ConversationCreated is published here: ConversationsService.create
    // already did, and a second one would run every listener twice — two SLA
    // clocks on one call, which this codebase has been bitten by before.

    return this.onAnswered(callId);
  }

  /**
   * The call is up. Decide what answers it — the number's route, or its
   * after-hours route when the office is shut.
   */
  private async onAnswered(callId: string): Promise<{ body?: unknown; contentType?: string }> {
    const call = await this.load(callId);
    if (call.answeredAt) return {};

    await this.prisma.db.call.update({
      where: { id: callId },
      data: { status: 'answered', answeredAt: new Date() },
    });

    const phoneNumber = call.phoneNumberId
      ? await this.prisma.db.phoneNumber.findFirst({ where: { id: call.phoneNumberId } })
      : null;

    let routeType = phoneNumber?.routeType ?? 'ivr';
    let routeId = phoneNumber?.routeId ?? null;

    if (phoneNumber?.businessHoursId && phoneNumber.afterHoursRouteType) {
      const calendar = await this.directory.calendarFor(phoneNumber.businessHoursId);
      if (!calendar.isOpenAt(new Date())) {
        routeType = phoneNumber.afterHoursRouteType;
        routeId = phoneNumber.afterHoursRouteId ?? null;
      }
    }

    const opening: CallAction[] = [];
    // Consent before the recorder starts, not after: a recording made before
    // the caller was told is the one that cannot be used.
    if (call.isRecorded) {
      opening.push({ kind: 'say', text: 'This call may be recorded for quality and training.' });
      opening.push({ kind: 'record', beep: false });
    }

    return this.enterRoute(callId, routeType, routeId, opening);
  }

  private async enterRoute(
    callId: string,
    routeType: string,
    routeId: string | null,
    opening: CallAction[] = [],
  ): Promise<{ body?: unknown; contentType?: string }> {
    switch (routeType) {
      case 'ivr': {
        const flow = await this.loadFlow(routeId);
        if (!flow) return this.respond(callId, [...opening, ...this.noRouteActions()]);

        const state = initialState(flow.definition);
        const outcome = step(flow.definition, state);
        await this.saveControl(callId, {
          mode: 'ivr',
          ivr: outcome.state,
          ivrFlowId: flow.id,
        });
        await this.prisma.db.call.update({
          where: { id: callId },
          data: { ivrFlowId: flow.id, ivrPath: outcome.state.path },
        });
        return this.applyOutcome(callId, flow.definition, outcome, opening);
      }

      case 'queue':
        return this.enqueue(callId, routeId, opening);

      case 'ai_agent':
        await this.saveControl(callId, { mode: 'ai_agent', aiAgentId: routeId ?? undefined });
        await this.prisma.db.call.update({ where: { id: callId }, data: { aiAgentId: routeId } });
        // The AI voice agent takes the first turn; the turn loop owns it from
        // here, which is Phase 24's job rather than the call service's.
        return this.respond(callId, [
          ...opening,
          { kind: 'listen', timeoutSec: 8, endpointingMs: 700 },
        ]);

      case 'agent':
        return this.connectAgent(callId, routeId, opening);

      case 'voicemail':
        await this.saveControl(callId, { mode: 'voicemail' });
        return this.respond(callId, [
          ...opening,
          { kind: 'say', text: 'Please leave a message after the tone.' },
          { kind: 'record', maxSeconds: 120, beep: true },
        ]);

      default:
        return this.respond(callId, [...opening, ...this.noRouteActions()]);
    }
  }

  // ── IVR turns ──────────────────────────────────────────────────────────────

  private async onDigits(
    callId: string,
    digits: string,
  ): Promise<{ body?: unknown; contentType?: string }> {
    const control = await this.control(callId);
    if (control.mode !== 'ivr' || !control.ivr || !control.ivrFlowId) return {};

    const flow = await this.loadFlow(control.ivrFlowId);
    if (!flow) return this.respond(callId, this.noRouteActions());

    const outcome = step(flow.definition, control.ivr, {
      digits,
      timedOut: digits.length === 0,
    });

    await this.prisma.db.call.update({
      where: { id: callId },
      data: {
        ivrPath: outcome.state.path,
        digits: Object.values(outcome.state.collected).join(',') || undefined,
      },
    });
    await this.record(callId, 'ivr_node', { node: outcome.state.nodeId, digits });

    return this.applyOutcome(callId, flow.definition, outcome);
  }

  /** Providers that recognize speech themselves deliver it here. */
  private async onSpeech(
    callId: string,
    text: string,
  ): Promise<{ body?: unknown; contentType?: string }> {
    const control = await this.control(callId);
    if (control.mode !== 'ai_agent') return {};
    await this.appendTranscript(callId, 'caller', text);
    // The AI turn loop is driven by the voice agent service, which subscribes
    // to this event; the call service only records what was heard.
    await this.record(callId, 'ai_turn', { speaker: 'caller', text });
    return {};
  }

  private async applyOutcome(
    callId: string,
    definition: IvrDefinition,
    outcome: ReturnType<typeof step>,
    opening: CallAction[] = [],
  ): Promise<{ body?: unknown; contentType?: string }> {
    const actions = [...opening, ...outcome.actions];

    switch (outcome.kind) {
      case 'continue':
        // Only the position moves between turns. Writing `ivrFlowId: undefined`
        // here would blank the flow the next webhook needs to resume, leaving
        // the caller listening to a menu nothing can advance.
        await this.saveControl(callId, { mode: 'ivr', ivr: outcome.state });
        return this.respond(callId, actions);

      case 'queue':
        return this.enqueue(callId, outcome.queueId, actions);

      case 'agent':
        return this.connectAgent(callId, outcome.userId, actions);

      case 'ai_agent':
        await this.saveControl(callId, { mode: 'ai_agent', aiAgentId: outcome.agentId });
        await this.prisma.db.call.update({
          where: { id: callId },
          data: { aiAgentId: outcome.agentId },
        });
        return this.respond(callId, [
          ...actions,
          { kind: 'listen', timeoutSec: 8, endpointingMs: 700 },
        ]);

      case 'transfer':
        await this.saveControl(callId, { mode: 'agent' });
        await this.prisma.db.call.update({
          where: { id: callId },
          data: { status: 'transferring' },
        });
        return this.respond(callId, actions);

      case 'voicemail':
        await this.saveControl(callId, { mode: 'voicemail' });
        return this.respond(callId, actions);

      case 'hangup':
        await this.markDisposition(callId, 'abandoned_in_ivr');
        await this.saveControl(callId, { mode: 'ended' });
        return this.respond(callId, actions);
    }
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  /**
   * Put the caller in a queue and hand the conversation to the routing engine.
   *
   * The same engine every other channel uses: skills, languages, availability,
   * business hours and concurrency are already solved there, and a second
   * implementation for voice would drift from the first within a release.
   */
  private async enqueue(
    callId: string,
    queueId: string | null,
    actions: CallAction[] = [],
  ): Promise<{ body?: unknown; contentType?: string }> {
    const call = await this.load(callId);
    if (!queueId) return this.respond(callId, [...actions, ...this.noRouteActions()]);

    const now = new Date();
    await this.prisma.db.call.update({
      where: { id: callId },
      data: { status: 'queued', queueId, queuedAt: now },
    });
    await this.saveControl(callId, { mode: 'queue' });

    if (call.conversationId) {
      await this.prisma.db.conversation.update({
        where: { id: call.conversationId },
        data: { queueId, status: 'queued', queuedAt: now },
      });

      const decision = await this.routing.route(call.conversationId).catch((error) => {
        this.logger.error('Routing a call failed', error, { callId });
        return null;
      });

      // An agent who is free right now is bridged immediately rather than
      // being made to wait for the queue sweep — the caller is on the line.
      if (decision?.assignee?.type === 'user') {
        return this.connectAgent(callId, decision.assignee.id, actions);
      }
    }

    return this.respond(callId, actions);
  }

  /** Bridge the caller to a named person. */
  private async connectAgent(
    callId: string,
    userId: string | null,
    actions: CallAction[] = [],
  ): Promise<{ body?: unknown; contentType?: string }> {
    if (!userId) return this.respond(callId, [...actions, ...this.noRouteActions()]);

    const user = await this.prisma.db.user.findFirst({ where: { id: userId } });
    const extension = await this.extensionFor(userId);
    if (!user || !extension) {
      this.logger.warn('No reachable extension for the assigned agent', { callId, userId });
      return this.respond(callId, [...actions, ...this.noRouteActions()]);
    }

    const call = await this.load(callId);
    await this.prisma.db.call.update({
      where: { id: callId },
      data: { status: 'transferring', assigneeId: userId },
    });
    await this.addParticipant(callId, 'agent', userId, `${user.firstName} ${user.lastName}`);

    if (call.conversationId)
      await this.conversations
        .assign(call.conversationId, { type: 'user', id: userId }, { reason: 'voice_route' })
        .catch(() => undefined);

    await this.saveControl(callId, { mode: 'agent' });
    return this.respond(callId, [
      ...actions,
      { kind: 'bridge', to: extension, timeoutSec: 30, callerId: call.fromNumber },
    ]);
  }

  // ── Call control (agent-initiated) ─────────────────────────────────────────

  async hold(callId: string) {
    const call = await this.load(callId);
    await this.act(call.id, [{ kind: 'pause', seconds: 0 }]);
    await this.record(callId, 'hold', {});
    return this.prisma.db.call.update({ where: { id: callId }, data: { status: 'on_hold' } });
  }

  async resume(callId: string) {
    await this.load(callId);
    await this.record(callId, 'resume', {});
    return this.prisma.db.call.update({
      where: { id: callId },
      data: { status: 'answered' },
    });
  }

  async transfer(callId: string, target: { userId?: string; queueId?: string; number?: string }) {
    const call = await this.load(callId);
    await this.record(callId, 'transfer', target);

    if (target.userId) {
      await this.connectAgent(callId, target.userId);
      return this.load(callId);
    }
    if (target.queueId) {
      await this.enqueue(callId, target.queueId);
      return this.load(callId);
    }
    if (target.number) {
      await this.act(call.id, [{ kind: 'bridge', to: target.number, callerId: call.fromNumber }]);
      await this.prisma.db.call.update({
        where: { id: callId },
        data: { status: 'transferring', disposition: 'transferred_external' },
      });
      return this.load(callId);
    }
    throw AppError.badRequest('A transfer needs a user, a queue or a number');
  }

  async hangup(callId: string, cause = 'agent_hangup') {
    const call = await this.load(callId);
    await this.act(call.id, [{ kind: 'hangup', cause }]);
    await this.end(callId, { cause, hangupBy: 'agent' });
    return this.load(callId);
  }

  async say(callId: string, text: string) {
    const call = await this.load(callId);
    await this.act(call.id, [{ kind: 'say', text }]);
    await this.appendTranscript(callId, 'agent', text);
    return { spoken: text };
  }

  /** Place an outbound call from one of the tenant's own numbers. */
  async originate(input: { from: string; to: string; userId?: string; customerId?: string }) {
    const phoneNumber = await this.prisma.db.phoneNumber.findFirst({
      where: { number: input.from, isActive: true },
    });
    if (!phoneNumber)
      throw AppError.badRequest(`${input.from} is not a number this organization owns`);

    const provider = phoneNumber.provider as TelephonyProviderKey;
    const adapter = this.registry.adapter(provider);
    if (!adapter.originate)
      throw AppError.badRequest(`The ${provider} provider cannot place outbound calls`);

    const account = await this.registry.accountForOrganization(provider);
    const callId = newId('call');
    const { providerCallId } = await adapter.originate(
      { from: input.from, to: input.to, reference: callId },
      account,
    );

    const { customer } = input.customerId
      ? { customer: { id: input.customerId } }
      : await this.customers.findOrCreateByContact('phone', input.to, { displayName: input.to });

    const conversation = await this.conversations.create({
      channel: 'voice',
      customerId: customer.id,
      subject: `Call to ${input.to}`,
      workspaceId: phoneNumber.workspaceId ?? undefined,
      externalId: providerCallId,
      threadKey: `call:${providerCallId}`,
      metadata: { direction: 'outbound', from: input.from, to: input.to },
    });

    await this.prisma.db.call.create({
      data: {
        id: callId,
        organizationId: RequestContextStore.organizationId()!,
        workspaceId: phoneNumber.workspaceId,
        conversationId: conversation.id,
        phoneNumberId: phoneNumber.id,
        customerId: customer.id,
        provider,
        providerCallId,
        direction: 'outbound',
        status: 'initiating',
        fromNumber: input.from,
        toNumber: input.to,
        assigneeId: input.userId,
        isRecorded: phoneNumber.recordCalls,
      },
    });

    await this.record(callId, 'initiated', { from: input.from, to: input.to });
    return this.load(callId);
  }

  // ── Ending ─────────────────────────────────────────────────────────────────

  async end(
    callId: string,
    options: { cause?: string; status?: CallStatus; hangupBy?: string } = {},
  ) {
    const call = await this.prisma.db.call.findFirst({ where: { id: callId } });
    if (!call || call.endedAt) return;

    const endedAt = new Date();
    const durationSec = Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000);
    const waitTimeSec = call.queuedAt
      ? Math.round(((call.connectedAt ?? endedAt).getTime() - call.queuedAt.getTime()) / 1000)
      : null;
    const talkTimeSec = call.connectedAt
      ? Math.round((endedAt.getTime() - call.connectedAt.getTime()) / 1000)
      : null;

    const disposition = call.disposition ?? this.inferDisposition(call);

    await this.prisma.db.call.update({
      where: { id: callId },
      data: {
        status: options.status ?? 'completed',
        endedAt,
        durationSec,
        waitTimeSec,
        talkTimeSec,
        disposition,
        hangupCause: options.cause,
        hangupBy: options.hangupBy,
      },
    });

    await this.record(callId, 'ended', { cause: options.cause, durationSec, disposition });
    this.metrics.callsTotal.inc({
      direction: call.direction,
      disposition: disposition ?? 'unknown',
    });

    // The conversation is left open when a person handled it — they still have
    // wrap-up to do — and closed when nobody ever will.
    if (
      call.conversationId &&
      ['abandoned_in_queue', 'abandoned_in_ivr', 'failed'].includes(disposition ?? '')
    ) {
      await this.prisma.db.conversation
        .update({
          where: { id: call.conversationId },
          data: { status: 'closed', closedAt: endedAt },
        })
        .catch(() => undefined);
    }

    await this.saveControl(callId, { mode: 'ended' });
    await this.events
      .publish(
        DomainEvent.ConversationClosed,
        { type: 'conversation', id: call.conversationId ?? callId },
        {
          callId,
          durationSec,
          disposition,
        },
      )
      .catch(() => undefined);
  }

  private inferDisposition(call: {
    status: CallStatus;
    queuedAt: Date | null;
    connectedAt: Date | null;
    assigneeId: string | null;
    aiAgentId: string | null;
    answeredAt: Date | null;
  }): CallDisposition {
    if (call.connectedAt || call.assigneeId) return 'handled_by_agent';
    if (call.aiAgentId) return 'handled_by_ai';
    if (call.queuedAt) return 'abandoned_in_queue';
    if (call.answeredAt) return 'abandoned_in_ivr';
    return 'failed';
  }

  async markDisposition(callId: string, disposition: CallDisposition) {
    await this.prisma.db.call.update({ where: { id: callId }, data: { disposition } });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async list(params: { status?: CallStatus; queueId?: string; limit?: number } = {}) {
    return this.prisma.db.call.findMany({
      where: {
        ...(params.status ? { status: params.status } : {}),
        ...(params.queueId ? { queueId: params.queueId } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: Math.min(params.limit ?? 50, 200),
    });
  }

  async get(callId: string) {
    const call = await this.prisma.db.call.findFirst({
      where: { id: callId },
      include: {
        events: { orderBy: { sequence: 'asc' } },
        recordings: true,
        participants: true,
        transcript: { orderBy: { sequence: 'asc' } },
      },
    });
    if (!call) throw AppError.notFound('Call', callId);
    return call;
  }

  async live() {
    return this.prisma.db.call.findMany({
      where: { endedAt: null },
      orderBy: { startedAt: 'asc' },
      take: 200,
    });
  }

  /** A recording is served from the platform's store, never the provider's URL. */
  async recordingContent(callId: string, recordingId: string) {
    const recording = await this.prisma.db.callRecording.findFirst({
      where: { id: recordingId, callId },
    });
    if (!recording) throw AppError.notFound('Recording', recordingId);

    return {
      content: await this.storage.get(recording.storageKey),
      contentType: recording.contentType,
      filename: `${callId}-${recordingId}.wav`,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async storeRecording(
    callId: string,
    provider: TelephonyProviderKey,
    event: NormalizedCallEvent,
  ) {
    if (!event.recordingUrl) return;
    const adapter = this.registry.adapter(provider);
    if (!adapter.fetchRecording) return;

    const call = await this.load(callId);
    const account = await this.registry.accountForOrganization(provider);

    try {
      const { content, contentType } = await adapter.fetchRecording(event.recordingUrl, account);
      const key = this.storage.buildKey(call.organizationId, 'call-recordings', `${callId}.wav`);
      await this.storage.put(key, content, contentType);

      const retentionDays = await this.retentionDays(call.organizationId);
      await this.prisma.db.callRecording.create({
        data: {
          id: newId('recording'),
          organizationId: call.organizationId,
          callId,
          storageKey: key,
          contentType,
          durationSec: event.recordingDurationSec ?? 0,
          sizeBytes: content.length,
          consentAt: call.answeredAt,
          expiresAt: retentionDays ? new Date(Date.now() + retentionDays * 86_400_000) : null,
        },
      });
      await this.record(callId, 'recording_stopped', { sizeBytes: content.length });
    } catch (error) {
      // A recording that cannot be fetched must not fail the call, which by
      // now has usually already ended.
      this.logger.error('Could not store a call recording', error, { callId });
    }
  }

  private async retentionDays(organizationId: string): Promise<number | null> {
    const policy = await this.prisma.raw.governancePolicy.findFirst({
      where: { organizationId },
      select: { dataRetentionDays: true },
    });
    return policy?.dataRetentionDays && policy.dataRetentionDays > 0
      ? policy.dataRetentionDays
      : null;
  }

  async appendTranscript(
    callId: string,
    speaker: 'caller' | 'agent' | 'ai_agent' | 'ivr' | 'external',
    text: string,
    options: {
      confidence?: number;
      startMs?: number;
      endMs?: number;
      /**
       * False when something else has already written this utterance into the
       * conversation — the agent runtime's own send-message node does, so
       * mirroring it again shows the caller's answer twice in the workspace.
       */
      mirror?: boolean;
    } = {},
  ) {
    if (!text.trim()) return;
    const call = await this.load(callId);
    const sequence = await this.nextSequence('callTranscriptSegment', callId);

    await this.prisma.db.callTranscriptSegment.create({
      data: {
        id: newId('transcript'),
        organizationId: call.organizationId,
        callId,
        sequence,
        speaker,
        text: text.slice(0, 4000),
        confidence: options.confidence,
        startMs: options.startMs ?? 0,
        endMs: options.endMs ?? 0,
      },
    });

    // The transcript is mirrored into the conversation so the workspace,
    // quality scoring and customer intelligence read a call exactly as they
    // read a chat — none of them should need to know voice exists.
    if (call.conversationId && options.mirror !== false) {
      await this.conversations
        .addMessage({
          conversationId: call.conversationId,
          body: text,
          direction: speaker === 'caller' ? 'inbound' : 'outbound',
          type: 'text',
          authorType:
            speaker === 'caller'
              ? 'customer'
              : speaker === 'ai_agent'
                ? 'ai_agent'
                : speaker === 'agent'
                  ? 'user'
                  : // An IVR prompt is the platform speaking, not a person.
                    'system',
          authorId: speaker === 'agent' ? (call.assigneeId ?? undefined) : undefined,
          metadata: { source: 'voice', speaker, confidence: options.confidence },
        })
        .catch((error) => this.logger.error('Mirroring a transcript segment failed', error));
    }
  }

  async addParticipant(
    callId: string,
    role: 'caller' | 'agent' | 'ai_agent' | 'ivr' | 'external',
    actorId?: string,
    label?: string,
  ) {
    const call = await this.load(callId);
    await this.prisma.db.callParticipant.create({
      data: {
        id: newId('callParticipant'),
        organizationId: call.organizationId,
        callId,
        role,
        actorId,
        label,
      },
    });
    if (role === 'agent' && !call.connectedAt) {
      await this.prisma.db.call.update({
        where: { id: callId },
        data: { connectedAt: new Date(), status: 'answered' },
      });
    }
  }

  async record(callId: string, type: string, payload: Record<string, unknown>) {
    const call = await this.prisma.db.call.findFirst({
      where: { id: callId },
      select: { organizationId: true },
    });
    if (!call) return;

    const sequence = await this.nextSequence('callEvent', callId);
    await this.prisma.db.callEvent.create({
      data: {
        id: newId('callEvent'),
        organizationId: call.organizationId,
        callId,
        sequence,
        type,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private async nextSequence(
    model: 'callEvent' | 'callTranscriptSegment',
    callId: string,
  ): Promise<number> {
    const last =
      model === 'callEvent'
        ? await this.prisma.db.callEvent.findFirst({
            where: { callId },
            orderBy: { sequence: 'desc' },
            select: { sequence: true },
          })
        : await this.prisma.db.callTranscriptSegment.findFirst({
            where: { callId },
            orderBy: { sequence: 'desc' },
            select: { sequence: true },
          });
    return (last?.sequence ?? 0) + 1;
  }

  /** Issue actions to the provider outside a webhook response. */
  private async act(callId: string, actions: CallAction[]) {
    const call = await this.load(callId);
    const adapter = this.registry.adapter(call.provider as TelephonyProviderKey);
    const account = await this.registry.accountForOrganization(
      call.provider as TelephonyProviderKey,
    );
    return adapter.control(call.providerCallId, actions, account);
  }

  private async respond(
    callId: string,
    actions: CallAction[],
  ): Promise<{ body?: unknown; contentType?: string }> {
    const call = await this.load(callId);
    const adapter = this.registry.adapter(call.provider as TelephonyProviderKey);
    const account = await this.registry.accountForOrganization(
      call.provider as TelephonyProviderKey,
    );

    for (const action of actions) {
      if (action.kind === 'say') await this.appendTranscript(callId, 'ivr', action.text);
    }
    return adapter.control(call.providerCallId, actions, account);
  }

  private noRouteActions(): CallAction[] {
    return [
      {
        kind: 'say',
        text: 'Sorry, we cannot take your call right now. Please try again later.',
      },
      { kind: 'hangup', cause: 'no_route' },
    ];
  }

  private async loadFlow(
    flowId: string | null,
  ): Promise<{ id: string; definition: IvrDefinition } | null> {
    const flow = flowId
      ? await this.prisma.db.ivrFlow.findFirst({ where: { id: flowId, isActive: true } })
      : await this.prisma.db.ivrFlow.findFirst({ where: { isActive: true } });
    if (!flow) return null;

    const definition = flow.definition as unknown as IvrDefinition;
    const errors = validateIvr(definition);
    if (errors.length) {
      // A flow that was valid when saved can be broken later by a deleted
      // queue; refusing to run it is better than stranding the caller inside.
      this.logger.error('An active IVR flow is not valid', undefined, {
        flowId: flow.id,
        errors,
      });
      return null;
    }
    return { id: flow.id, definition };
  }

  private async control(callId: string): Promise<CallControlState> {
    const call = await this.load(callId);
    const metadata = (call.metadata ?? {}) as { control?: CallControlState };
    return metadata.control ?? { mode: 'ivr' };
  }

  private async saveControl(callId: string, patch: Partial<CallControlState>, merge = false) {
    const call = await this.load(callId);
    const metadata = (call.metadata ?? {}) as Record<string, unknown>;
    const current = (metadata.control ?? {}) as CallControlState;

    await this.prisma.db.call.update({
      where: { id: callId },
      data: {
        metadata: {
          ...metadata,
          control: merge ? { ...current, ...patch } : { ...current, ...patch },
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async extensionFor(userId: string): Promise<string | null> {
    const membership = await this.prisma.db.membership.findFirst({
      where: { userId },
      select: { workspaceIds: true },
    });
    if (!membership) return null;

    // An agent's SIP endpoint, stored on their phone number record. Without
    // one there is nothing to bridge to, which is why this returns null rather
    // than inventing an address the provider would fail to reach.
    const number = await this.prisma.db.phoneNumber.findFirst({
      where: { routeType: 'agent', routeId: userId, isActive: true },
      select: { number: true },
    });
    return number?.number ?? null;
  }

  private async load(callId: string) {
    const call = await this.prisma.db.call.findFirst({ where: { id: callId } });
    if (!call) throw AppError.notFound('Call', callId);
    return call;
  }
}
