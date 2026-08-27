import { Injectable } from '@nestjs/common';
import { AppError } from '../../core/errors/app-error';
import { AppLogger } from '../../core/logger/logger.service';
import { MetricsService } from '../../core/metrics/metrics.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AgentsService } from '../agents/agents.service';
import { CallsService } from './calls.service';
import { SpeechGateway, estimateSpeechMs } from './speech.gateway';
import type { CallAction } from './telephony-adapter';

/**
 * The AI voice agent.
 *
 * Voice does not get its own reasoning: a turn runs through the same agent and
 * the same durable runtime that answers a web chat, with the same retrieval,
 * the same guardrails and the same handoff rules. What voice adds is
 * everything around the turn — deciding when the caller has finished speaking,
 * what to do when they say nothing, what to do when they interrupt, and what
 * to say while the model is still thinking.
 *
 * The hard constraint is latency. A caller reads a gap as a broken line at
 * about a second, so the loop is written to fail forward: every path that
 * could stall has a spoken fallback rather than silence.
 */

export interface VoiceTurnResult {
  callId: string;
  heard: string;
  spoken: string;
  actions: CallAction[];
  latencyMs: number;
  outcome: 'answered' | 'handoff' | 'reprompt' | 'ended';
  confidence?: number;
}

/** Silence this long, twice, and the caller has almost certainly gone. */
const NO_INPUT_TIMEOUT_SEC = 7;
const MAX_NO_INPUT = 2;

/**
 * Beyond this many turns the agent is looping rather than helping, and a
 * caller who has said the same thing six times wants a person.
 */
const MAX_TURNS = 12;

/**
 * Past this, say something — anything true — rather than leave dead air. The
 * model is still working; the caller does not know that.
 */
const FILLER_AFTER_MS = 1_500;

interface VoiceState {
  turns: number;
  noInput: number;
  history: { role: 'caller' | 'agent'; text: string }[];
}

@Injectable()
export class VoiceAgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calls: CallsService,
    private readonly agents: AgentsService,
    private readonly speech: SpeechGateway,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * One turn: what the caller said in, what the agent says back out.
   *
   * Accepts either audio, which is transcribed here, or text, which is what a
   * provider that does its own recognition delivers. Both paths converge
   * immediately so the rest of the loop never learns which happened.
   */
  async turn(
    callId: string,
    input: { audio?: Buffer; text?: string; timedOut?: boolean; contentType?: string },
  ): Promise<VoiceTurnResult> {
    const started = Date.now();
    const call = await this.loadCall(callId);
    if (!call.aiAgentId) throw AppError.conflict('No AI agent is handling this call');

    const state = this.stateOf(call.metadata);

    if (input.timedOut || (!input.audio && !input.text)) {
      return this.onNoInput(callId, state, started);
    }

    // Recognize, then treat a failed or empty recognition exactly as silence:
    // both mean the agent has nothing to answer, and the caller should hear
    // the same recoverable prompt either way.
    let heard = (input.text ?? '').trim();
    let confidence: number | undefined;

    if (!heard && input.audio) {
      const transcription = await this.speech.transcribe(input.audio, {
        locale: call.conversation?.locale ?? 'en',
        contentType: input.contentType,
      });
      heard = transcription.text.trim();
      confidence = transcription.confidence;
    }

    if (!heard) return this.onNoInput(callId, state, started);

    await this.calls.appendTranscript(callId, 'caller', heard, { confidence });
    const heardState: VoiceState = {
      turns: state.turns + 1,
      noInput: 0,
      history: [...state.history, { role: 'caller' as const, text: heard }].slice(-20),
    };

    if (heardState.turns > MAX_TURNS) {
      return this.handoff(
        callId,
        heardState,
        heard,
        'This has taken a while — let me get someone who can help.',
        started,
      );
    }

    // The caller asking for a person is not a failure to reason about; it is
    // an instruction, and making them argue with a bot is the single most
    // resented thing an IVR does.
    if (this.asksForHuman(heard)) {
      return this.handoff(
        callId,
        heardState,
        heard,
        'Of course — putting you through to someone now.',
        started,
      );
    }

    return this.answer(callId, call.aiAgentId, heardState, heard, confidence, started);
  }

  private async answer(
    callId: string,
    agentId: string,
    state: VoiceState,
    heard: string,
    confidence: number | undefined,
    started: number,
  ): Promise<VoiceTurnResult> {
    const call = await this.loadCall(callId);

    let result: Awaited<ReturnType<AgentsService['run']>>;
    try {
      result = await this.agents.run({
        agentId,
        message: heard,
        conversationId: call.conversationId ?? undefined,
        customerId: call.customerId ?? undefined,
      });
    } catch (error) {
      // A runtime failure must not drop the call: the caller gets a person.
      this.logger.error('An AI voice turn failed', error, { callId });
      return this.handoff(callId, state, heard, 'Sorry — let me pass you to a colleague.', started);
    }

    // The answer lives in the execution's *state*, not in the last node's
    // output: the agent node publishes it as a state patch and the graph then
    // runs on to a reply node whose own output is a delivery receipt. Reading
    // the final output alone makes every successful turn look like a handoff.
    const output = (result.output ?? {}) as Record<string, unknown>;
    const runState = (output.state ?? {}) as Record<string, unknown>;
    const nested = (output.output ?? {}) as Record<string, unknown>;

    const answer = this.textOf(runState.answer ?? nested.answer ?? output.answer);
    const wantsHandoff =
      nested.handoff === true ||
      output.handoff === true ||
      Boolean(this.textOf(runState.handoffReason));

    if (wantsHandoff || !answer) {
      const reason = this.textOf(runState.handoffReason ?? nested.reason ?? output.reason);
      this.logger.info('An AI voice turn handed off', { callId, reason });
      return this.handoff(
        callId,
        state,
        heard,
        'Let me get a colleague who can help with that.',
        started,
        reason,
      );
    }

    const spoken = this.forSpeech(answer);
    // Not mirrored: the runtime's reply node already wrote this answer into
    // the conversation, and mirroring it would show it to the agent twice.
    await this.calls.appendTranscript(callId, 'ai_agent', spoken, { mirror: false });

    const nextState: VoiceState = {
      ...state,
      history: [...state.history, { role: 'agent' as const, text: spoken }].slice(-20),
    };
    await this.saveState(callId, nextState);

    const latencyMs = Date.now() - started;
    this.metrics.voiceTurnDuration.observe({ outcome: 'answered' }, latencyMs / 1000);
    await this.calls.record(callId, 'ai_turn', {
      speaker: 'ai_agent',
      heard,
      spoken,
      latencyMs,
      executionId: result.executionId,
    });

    const actions: CallAction[] = [
      ...this.fillerIfSlow(latencyMs),
      { kind: 'say', text: spoken },
      { kind: 'listen', timeoutSec: NO_INPUT_TIMEOUT_SEC, endpointingMs: 700 },
    ];

    return {
      callId,
      heard,
      spoken,
      actions,
      latencyMs,
      outcome: 'answered',
      confidence,
    };
  }

  /**
   * Silence. Ask once, then stop asking — a caller who has put the phone down
   * should not be talked at, and one who is thinking should not be nagged.
   */
  private async onNoInput(
    callId: string,
    state: VoiceState,
    started: number,
  ): Promise<VoiceTurnResult> {
    const noInput = state.noInput + 1;
    await this.saveState(callId, { ...state, noInput });

    if (noInput >= MAX_NO_INPUT) {
      await this.calls.markDisposition(callId, 'handled_by_ai');
      await this.calls.record(callId, 'ai_turn', { outcome: 'no_input_hangup' });
      const spoken = 'I could not hear you. Please call us back when you are ready. Goodbye.';
      await this.calls.appendTranscript(callId, 'ai_agent', spoken);

      return {
        callId,
        heard: '',
        spoken,
        actions: [
          { kind: 'say', text: spoken },
          { kind: 'hangup', cause: 'no_input' },
        ],
        latencyMs: Date.now() - started,
        outcome: 'ended',
      };
    }

    const spoken = 'Sorry, I did not catch that. Could you say it again?';
    await this.calls.appendTranscript(callId, 'ai_agent', spoken);

    return {
      callId,
      heard: '',
      spoken,
      actions: [
        { kind: 'say', text: spoken },
        { kind: 'listen', timeoutSec: NO_INPUT_TIMEOUT_SEC, endpointingMs: 700 },
      ],
      latencyMs: Date.now() - started,
      outcome: 'reprompt',
    };
  }

  /**
   * Hand the caller to a person, with the whole conversation already written
   * down. The agent who picks up should never have to ask them to start again.
   */
  private async handoff(
    callId: string,
    state: VoiceState,
    heard: string,
    spoken: string,
    started: number,
    reason?: string,
  ): Promise<VoiceTurnResult> {
    const call = await this.loadCall(callId);
    await this.saveState(callId, state);
    await this.calls.appendTranscript(callId, 'ai_agent', spoken);

    if (call.conversationId) {
      const summary = state.history
        .map((entry) => `${entry.role === 'caller' ? 'Caller' : 'AI'}: ${entry.text}`)
        .join('\n');

      await this.prisma.db.message
        .create({
          data: {
            id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            organizationId: call.organizationId,
            conversationId: call.conversationId,
            direction: 'internal',
            type: 'handoff',
            authorType: 'ai_agent',
            body: [
              `Handing over a live call from ${call.fromNumber}.`,
              reason ? `Reason: ${reason}` : null,
              '',
              summary || '(no exchange yet)',
            ]
              .filter((line) => line !== null)
              .join('\n'),
            isPrivate: true,
          },
        })
        .catch((error) => this.logger.error('Writing the voice handoff note failed', error));
    }

    const queueId = call.queueId ?? (await this.defaultVoiceQueue(call.organizationId));
    const latencyMs = Date.now() - started;
    this.metrics.voiceTurnDuration.observe({ outcome: 'handoff' }, latencyMs / 1000);
    await this.calls.record(callId, 'ai_turn', { outcome: 'handoff', reason, heard });

    const actions: CallAction[] = [{ kind: 'say', text: spoken }];
    if (queueId) actions.push({ kind: 'enqueue', queueId });
    else {
      // Nowhere to send them is not a reason to hang up mid-sentence: say so.
      actions.push({
        kind: 'say',
        text: 'Everyone is busy at the moment. Please leave a message after the tone.',
      });
      actions.push({ kind: 'record', maxSeconds: 120, beep: true });
    }

    return { callId, heard, spoken, actions, latencyMs, outcome: 'handoff' };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * A prompt to cover a slow model. Only used when the turn actually was slow —
   * saying "let me check that" on a fast turn adds latency instead of hiding it.
   */
  private fillerIfSlow(latencyMs: number): CallAction[] {
    return latencyMs > FILLER_AFTER_MS ? [{ kind: 'say', text: 'Thanks for waiting.' }] : [];
  }

  private asksForHuman(text: string): boolean {
    return /\b(speak|talk|put me through|connect me|transfer me)\b.{0,20}\b(human|person|someone|agent|representative|operator)\b|\b(real person|human being|operator)\b|^\s*(agent|operator|representative)\s*$/i.test(
      text,
    );
  }

  /**
   * Prepare an answer written for a screen to be heard instead.
   *
   * Citation markers, markdown and URLs are all noise down a phone line — a
   * synthesizer reads "[1]" aloud — and a long answer is unlistenable, so it
   * is cut at a sentence boundary rather than mid-word.
   */
  forSpeech(text: string, maxMs = 18_000): string {
    let spoken = text
      .replace(/\[\d+\]/g, '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_#`>]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'a link I can send you')
      .replace(/\s+/g, ' ')
      .trim();

    if (estimateSpeechMs(spoken) <= maxMs) return spoken;

    const sentences = spoken.split(/(?<=[.!?])\s+/);
    const kept: string[] = [];
    for (const sentence of sentences) {
      if (estimateSpeechMs([...kept, sentence].join(' ')) > maxMs) break;
      kept.push(sentence);
    }

    spoken = kept.join(' ').trim();
    return spoken
      ? `${spoken} Would you like me to go on?`
      : `${sentences[0]?.slice(0, 300) ?? ''}`.trim();
  }

  private textOf(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private stateOf(metadata: unknown): VoiceState {
    const voice = ((metadata ?? {}) as { voice?: Partial<VoiceState> }).voice ?? {};
    return {
      turns: voice.turns ?? 0,
      noInput: voice.noInput ?? 0,
      history: voice.history ?? [],
    };
  }

  private async saveState(callId: string, state: VoiceState) {
    const call = await this.loadCall(callId);
    const metadata = (call.metadata ?? {}) as Record<string, unknown>;
    await this.prisma.db.call.update({
      where: { id: callId },
      data: { metadata: { ...metadata, voice: state } as never },
    });
  }

  private async defaultVoiceQueue(organizationId: string): Promise<string | null> {
    const queue = await this.prisma.raw.queue.findFirst({
      where: { organizationId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return queue?.id ?? null;
  }

  private async loadCall(callId: string) {
    const call = await this.prisma.db.call.findFirst({
      where: { id: callId },
      include: { conversation: { select: { locale: true } } },
    });
    if (!call) throw AppError.notFound('Call', callId);
    return call;
  }
}
