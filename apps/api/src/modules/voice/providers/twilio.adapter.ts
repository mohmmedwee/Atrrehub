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
 * Twilio Programmable Voice.
 *
 * Control is expressed as TwiML returned from the webhook, so `control()`
 * renders a document rather than issuing API calls — one HTTP response instead
 * of a round-trip per action, which is the difference between a prompt that
 * feels instant and one that stutters.
 */
@Injectable()
export class TwilioTelephonyAdapter implements TelephonyAdapter {
  readonly key = 'twilio' as const;

  async receive(payload: unknown): Promise<NormalizedCallEvent | null> {
    const body = (payload ?? {}) as Record<string, string>;
    const providerCallId = body.CallSid;
    if (!providerCallId) return null;

    const base = {
      providerCallId,
      from: body.From,
      to: body.To,
      direction: body.Direction?.startsWith('outbound')
        ? ('outbound' as const)
        : ('inbound' as const),
      timestamp: new Date(),
      raw: body,
    };

    if (body.Digits) return { ...base, type: 'dtmf', digits: body.Digits };
    if (body.SpeechResult) return { ...base, type: 'speech', text: body.SpeechResult };
    if (body.RecordingUrl)
      return {
        ...base,
        type: 'recording_available',
        recordingUrl: body.RecordingUrl,
        recordingDurationSec: Number(body.RecordingDuration ?? 0) || undefined,
      };

    switch (body.CallStatus) {
      case 'ringing':
        return { ...base, type: 'ringing' };
      case 'in-progress':
      case 'answered':
        return { ...base, type: 'answered' };
      case 'completed':
        return { ...base, type: 'hangup', cause: body.CallStatus };
      case 'busy':
      case 'no-answer':
      case 'failed':
      case 'canceled':
        return { ...base, type: 'failed', cause: body.CallStatus };
      case 'queued':
      case 'initiated':
        return { ...base, type: 'initiated' };
      default:
        return null;
    }
  }

  async control(
    _providerCallId: string,
    actions: CallAction[],
    account: TelephonyAccount,
  ): Promise<{ body?: unknown; contentType?: string }> {
    const callbackUrl = String(account.config.callbackUrl ?? '');
    const verbs = actions.map((action) => this.toTwiml(action, callbackUrl)).join('');
    return {
      contentType: 'text/xml; charset=utf-8',
      body: `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs}</Response>`,
    };
  }

  async originate(
    request: OriginateRequest,
    account: TelephonyAccount,
  ): Promise<{ providerCallId: string }> {
    const accountSid = account.credentials.accountSid ?? '';
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(
            `${accountSid}:${account.credentials.authToken ?? ''}`,
          ).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          From: request.from,
          To: request.to,
          Url: `${account.config.callbackUrl ?? ''}?reference=${encodeURIComponent(request.reference)}`,
          Timeout: String(request.timeoutSec ?? 30),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Twilio refused the call (${response.status}): ${detail.slice(0, 200)}`);
    }
    const payload = (await response.json()) as { sid?: string };
    if (!payload.sid) throw new Error('Twilio returned no call SID');
    return { providerCallId: payload.sid };
  }

  async fetchRecording(
    url: string,
    account: TelephonyAccount,
  ): Promise<{ content: Buffer; contentType: string }> {
    // Twilio's recording URLs are stable and effectively public if leaked, so
    // the recording is pulled into the platform's own store immediately and
    // served from there instead.
    const response = await fetch(`${url}.wav`, {
      headers: {
        authorization: `Basic ${Buffer.from(
          `${account.credentials.accountSid ?? ''}:${account.credentials.authToken ?? ''}`,
        ).toString('base64')}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Could not fetch the recording (${response.status})`);
    return {
      content: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'audio/wav',
    };
  }

  /**
   * Twilio signs `url + sorted(params)` with the auth token. A telephony
   * webhook can move a live call and expose its recording, so an unsigned one
   * is refused rather than merely logged.
   */
  verifySignature(
    payload: unknown,
    headers: Record<string, string | undefined>,
    account: TelephonyAccount,
  ): boolean {
    const signature = headers['x-twilio-signature'];
    const authToken = account.credentials.authToken;
    const url = String(account.config.callbackUrl ?? '');
    if (!signature || !authToken || !url) return false;

    const params = (payload ?? {}) as Record<string, string>;
    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + String(params[key]), url);

    const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'base64');
    } catch {
      return false;
    }
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  capabilities(): TelephonyCapabilities {
    return {
      supportsMediaStreaming: true,
      supportsProviderSpeech: true,
      supportsRecording: true,
      supportsTransfer: true,
      supportsHold: true,
      supportsOutbound: true,
      supportsBargeIn: true,
    };
  }

  private toTwiml(action: CallAction, callbackUrl: string): string {
    switch (action.kind) {
      case 'say':
        return `<Say${action.locale ? ` language="${escapeXml(action.locale)}"` : ''}${
          action.voice ? ` voice="${escapeXml(action.voice)}"` : ''
        }>${escapeXml(action.text)}</Say>`;
      case 'play':
        return `<Play>${escapeXml(action.url)}</Play>`;
      case 'collect':
        return `<Gather numDigits="${action.maxDigits}" timeout="${action.timeoutSec}"${
          action.terminator ? ` finishOnKey="${escapeXml(action.terminator)}"` : ''
        } action="${escapeXml(callbackUrl)}" method="POST">${
          action.say ? `<Say>${escapeXml(action.say)}</Say>` : ''
        }</Gather>`;
      case 'listen':
        return `<Gather input="speech" speechTimeout="${
          action.endpointingMs ? Math.ceil(action.endpointingMs / 1000) : 'auto'
        }" timeout="${action.timeoutSec}" action="${escapeXml(callbackUrl)}" method="POST"/>`;
      case 'bridge':
        return `<Dial timeout="${action.timeoutSec ?? 30}"${
          action.callerId ? ` callerId="${escapeXml(action.callerId)}"` : ''
        }>${escapeXml(action.to)}</Dial>`;
      case 'enqueue':
        return `<Enqueue${
          action.holdMusicUrl ? ` waitUrl="${escapeXml(action.holdMusicUrl)}"` : ''
        }>${escapeXml(action.queueId)}</Enqueue>`;
      case 'record':
        return `<Record${action.maxSeconds ? ` maxLength="${action.maxSeconds}"` : ''} playBeep="${
          action.beep !== false
        }" action="${escapeXml(callbackUrl)}"/>`;
      case 'pause':
        return `<Pause length="${action.seconds}"/>`;
      case 'hangup':
        return '<Hangup/>';
    }
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
