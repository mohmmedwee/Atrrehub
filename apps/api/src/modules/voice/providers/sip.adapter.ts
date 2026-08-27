import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CallAction,
  NormalizedCallEvent,
  OriginateRequest,
  TelephonyAccount,
  TelephonyAdapter,
  TelephonyCapabilities,
} from '../telephony-adapter';

/**
 * A generic SIP media gateway.
 *
 * Self-hosted stacks — Asterisk with ARI, FreeSWITCH with ESL, Kamailio in
 * front of either — differ in wire protocol but not in vocabulary: they all
 * answer, play, collect, bridge and hang up. This adapter targets a small JSON
 * control API over that vocabulary, which is the shape a thin gateway process
 * in front of any of them exposes, and which keeps SIP's transport out of the
 * application entirely.
 *
 * The gateway URL and shared secret are per-account, so a private-cloud tenant
 * points this at their own PBX without the platform ever speaking SIP.
 */
@Injectable()
export class SipTelephonyAdapter implements TelephonyAdapter {
  readonly key = 'sip' as const;

  async receive(payload: unknown): Promise<NormalizedCallEvent | null> {
    const event = (payload ?? {}) as Record<string, unknown>;
    const providerCallId = String(event.callId ?? event.uuid ?? '');
    if (!providerCallId) return null;

    // Asterisk and FreeSWITCH name the same moments differently; both are
    // mapped here rather than in the call service, which should never learn
    // that CHANNEL_ANSWER and StasisStart mean the same thing.
    const type = this.mapEventName(String(event.event ?? event.type ?? ''));
    if (!type) return null;

    return {
      providerCallId,
      type,
      from: event.from ? String(event.from) : (event.caller_id_number as string | undefined),
      to: event.to ? String(event.to) : (event.destination_number as string | undefined),
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

  async control(
    providerCallId: string,
    actions: CallAction[],
    account: TelephonyAccount,
  ): Promise<{ body?: unknown; contentType?: string }> {
    const gateway = String(account.config.gatewayUrl ?? '');
    if (!gateway) throw new Error('This SIP account has no gateway URL configured');

    const response = await fetch(`${gateway.replace(/\/+$/, '')}/calls/${providerCallId}/control`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${account.credentials.gatewayToken ?? ''}`,
      },
      body: JSON.stringify({ actions }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `The SIP gateway rejected the control request (${response.status}): ${detail.slice(0, 200)}`,
      );
    }
    return { contentType: 'application/json', body: { accepted: true } };
  }

  async originate(
    request: OriginateRequest,
    account: TelephonyAccount,
  ): Promise<{ providerCallId: string }> {
    const gateway = String(account.config.gatewayUrl ?? '').replace(/\/+$/, '');
    const response = await fetch(`${gateway}/calls`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${account.credentials.gatewayToken ?? ''}`,
      },
      body: JSON.stringify({
        from: request.from,
        to: request.to,
        reference: request.reference,
        timeoutSec: request.timeoutSec ?? 30,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`The SIP gateway refused the call (${response.status})`);

    const payload = (await response.json()) as { callId?: string };
    if (!payload.callId) throw new Error('The SIP gateway returned no call id');
    return { providerCallId: payload.callId };
  }

  async fetchRecording(
    url: string,
    account: TelephonyAccount,
  ): Promise<{ content: Buffer; contentType: string }> {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${account.credentials.gatewayToken ?? ''}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Could not fetch the recording (${response.status})`);
    return {
      content: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'audio/wav',
    };
  }

  /** HMAC-SHA256 over the raw body, the same scheme the platform's own webhooks use. */
  verifySignature(
    _payload: unknown,
    headers: Record<string, string | undefined>,
    account: TelephonyAccount,
    rawBody?: string,
  ): boolean {
    const signature = headers['x-gateway-signature'];
    const secret = account.credentials.webhookSecret;
    if (!signature || !secret || rawBody === undefined) return false;

    const expected = createHmac('sha256', secret).update(rawBody).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  capabilities(): TelephonyCapabilities {
    return {
      supportsMediaStreaming: true,
      supportsProviderSpeech: false,
      supportsRecording: true,
      supportsTransfer: true,
      supportsHold: true,
      supportsOutbound: true,
      supportsBargeIn: true,
    };
  }

  private mapEventName(name: string): NormalizedCallEvent['type'] | null {
    switch (name.toLowerCase()) {
      case 'stasisstart':
      case 'channel_create':
      case 'initiated':
        return 'initiated';
      case 'channel_progress':
      case 'ringing':
        return 'ringing';
      case 'channel_answer':
      case 'answered':
        return 'answered';
      case 'dtmfreceived':
      case 'dtmf':
        return 'dtmf';
      case 'speech':
        return 'speech';
      case 'recording_available':
      case 'recordingfinished':
        return 'recording_available';
      case 'stasisend':
      case 'channel_hangup_complete':
      case 'hangup':
        return 'hangup';
      case 'failed':
        return 'failed';
      default:
        return null;
    }
  }
}
