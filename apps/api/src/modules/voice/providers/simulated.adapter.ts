import { Injectable } from '@nestjs/common';
import type {
  CallAction,
  NormalizedCallEvent,
  OriginateRequest,
  TelephonyAdapter,
  TelephonyCapabilities,
} from '../telephony-adapter';

/**
 * A telephony provider that needs no telephony.
 *
 * The platform ships with a deterministic local AI provider so the whole
 * product runs with no API key; this is the same idea for voice. It accepts
 * the platform's control actions, records them, and answers with a plain
 * transcript of what a caller would have heard — so the call state machine,
 * the IVR, routing, recording bookkeeping and the AI voice agent are all
 * exercised, in tests and in a demo, without a carrier account or a SIP trunk.
 *
 * What it cannot do is carry audio. It is a real implementation of the control
 * plane and an honest stand-in for the media plane, and the capability flags
 * say so rather than pretending otherwise.
 */
@Injectable()
export class SimulatedTelephonyAdapter implements TelephonyAdapter {
  readonly key = 'simulated' as const;

  async receive(payload: unknown): Promise<NormalizedCallEvent | null> {
    const event = (payload ?? {}) as Record<string, unknown>;
    const type = String(event.type ?? '');

    const known: NormalizedCallEvent['type'][] = [
      'initiated',
      'ringing',
      'answered',
      'dtmf',
      'speech',
      'recording_available',
      'hangup',
      'failed',
    ];
    if (!known.includes(type as NormalizedCallEvent['type'])) return null;

    const providerCallId = String(event.callId ?? event.providerCallId ?? '');
    if (!providerCallId) return null;

    return {
      providerCallId,
      type: type as NormalizedCallEvent['type'],
      from: event.from ? String(event.from) : undefined,
      to: event.to ? String(event.to) : undefined,
      direction: event.direction === 'outbound' ? 'outbound' : 'inbound',
      digits: event.digits ? String(event.digits) : undefined,
      text: event.text ? String(event.text) : undefined,
      recordingUrl: event.recordingUrl ? String(event.recordingUrl) : undefined,
      recordingDurationSec: Number(event.recordingDurationSec ?? 0) || undefined,
      cause: event.cause ? String(event.cause) : undefined,
      hangupBy: (event.hangupBy as NormalizedCallEvent['hangupBy']) ?? undefined,
      timestamp: new Date(),
      raw: event,
    };
  }

  /**
   * Return the actions as a readable script rather than a provider document.
   * A test asserts against what the caller would have heard, which is the
   * thing that actually matters and the thing a TwiML blob obscures.
   */
  async control(
    providerCallId: string,
    actions: CallAction[],
  ): Promise<{ body?: unknown; contentType?: string }> {
    return {
      contentType: 'application/json',
      body: {
        callId: providerCallId,
        actions,
        transcript: actions.map((action) => describe(action)),
      },
    };
  }

  async originate(request: OriginateRequest): Promise<{ providerCallId: string }> {
    return { providerCallId: `sim-${request.reference}` };
  }

  async fetchRecording(_url: string): Promise<{ content: Buffer; contentType: string }> {
    // A recognizable, valid, silent WAV: enough for the storage, retention and
    // transcription paths to be exercised for real.
    return { content: silentWav(1), contentType: 'audio/wav' };
  }

  capabilities(): TelephonyCapabilities {
    return {
      supportsMediaStreaming: false,
      supportsProviderSpeech: true,
      supportsRecording: true,
      supportsTransfer: true,
      supportsHold: true,
      supportsOutbound: true,
      supportsBargeIn: true,
    };
  }
}

function describe(action: CallAction): string {
  switch (action.kind) {
    case 'say':
      return `[say] ${action.text}`;
    case 'play':
      return `[play] ${action.url}`;
    case 'collect':
      return `[collect ${action.maxDigits} digit(s), ${action.timeoutSec}s] ${action.say ?? ''}`.trim();
    case 'listen':
      return `[listen ${action.timeoutSec}s]`;
    case 'bridge':
      return `[bridge] ${action.to}`;
    case 'enqueue':
      return `[enqueue] ${action.queueId}`;
    case 'record':
      return `[record${action.maxSeconds ? ` ${action.maxSeconds}s` : ''}]`;
    case 'pause':
      return `[pause ${action.seconds}s]`;
    case 'hangup':
      return `[hangup${action.cause ? ` ${action.cause}` : ''}]`;
  }
}

/** A minimal 8 kHz mono PCM WAV of `seconds` silence. */
function silentWav(seconds: number): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}
