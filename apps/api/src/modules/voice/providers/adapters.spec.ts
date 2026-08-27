import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SimulatedTelephonyAdapter } from './simulated.adapter';
import { SipTelephonyAdapter } from './sip.adapter';
import { TwilioTelephonyAdapter } from './twilio.adapter';
import type { TelephonyAccount } from '../telephony-adapter';

const twilio = new TwilioTelephonyAdapter();
const sip = new SipTelephonyAdapter();
const simulated = new SimulatedTelephonyAdapter();

const CALLBACK = 'https://app.example.com/api/v1/voice/webhooks/twilio';
const AUTH_TOKEN = 'test-auth-token';

const account: TelephonyAccount = {
  id: 'acct',
  organizationId: 'org',
  credentials: { accountSid: 'AC123', authToken: AUTH_TOKEN },
  config: { callbackUrl: CALLBACK },
};

/** Twilio's documented scheme: HMAC-SHA1 over the URL plus sorted params. */
function twilioSignature(params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], CALLBACK);
  return createHmac('sha1', AUTH_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
}

describe('Twilio webhook verification', () => {
  const params = {
    CallSid: 'CA1',
    From: '+15550001111',
    To: '+15550002222',
    CallStatus: 'ringing',
  };

  it('accepts a correctly signed request', () => {
    expect(
      twilio.verifySignature(params, { 'x-twilio-signature': twilioSignature(params) }, account),
    ).toBe(true);
  });

  it('rejects a tampered parameter', () => {
    const signature = twilioSignature(params);
    const forged = { ...params, To: '+15559999999' };
    expect(twilio.verifySignature(forged, { 'x-twilio-signature': signature }, account)).toBe(
      false,
    );
  });

  it('rejects an added parameter', () => {
    const signature = twilioSignature(params);
    expect(
      twilio.verifySignature(
        { ...params, Digits: '9' },
        { 'x-twilio-signature': signature },
        account,
      ),
    ).toBe(false);
  });

  it('rejects a missing signature outright', () => {
    expect(twilio.verifySignature(params, {}, account)).toBe(false);
  });

  it('rejects a signature that is not even base64', () => {
    expect(twilio.verifySignature(params, { 'x-twilio-signature': '!!!' }, account)).toBe(false);
  });

  it('rejects when the account has no auth token to verify against', () => {
    expect(
      twilio.verifySignature(
        params,
        { 'x-twilio-signature': twilioSignature(params) },
        { ...account, credentials: {} },
      ),
    ).toBe(false);
  });
});

describe('Twilio event mapping', () => {
  it('maps call states to platform events', async () => {
    const map = async (body: Record<string, string>) =>
      (await twilio.receive({ CallSid: 'CA1', ...body }))?.type;

    expect(await map({ CallStatus: 'ringing' })).toBe('ringing');
    expect(await map({ CallStatus: 'in-progress' })).toBe('answered');
    expect(await map({ CallStatus: 'completed' })).toBe('hangup');
    expect(await map({ CallStatus: 'busy' })).toBe('failed');
    expect(await map({ CallStatus: 'no-answer' })).toBe('failed');
  });

  it('reads DTMF, speech and recordings ahead of the call state', async () => {
    expect((await twilio.receive({ CallSid: 'CA1', Digits: '42' }))?.digits).toBe('42');
    expect((await twilio.receive({ CallSid: 'CA1', SpeechResult: 'hello' }))?.text).toBe('hello');

    expect(
      await twilio.receive({
        CallSid: 'CA1',
        RecordingUrl: 'https://api.twilio.com/rec/1',
        RecordingDuration: '17',
      }),
    ).toMatchObject({
      type: 'recording_available',
      recordingUrl: 'https://api.twilio.com/rec/1',
      recordingDurationSec: 17,
    });
  });

  it('ignores a payload with no call id rather than inventing one', async () => {
    expect(await twilio.receive({ CallStatus: 'ringing' })).toBeNull();
  });
});

describe('Twilio control rendering', () => {
  it('renders say, gather and dial as TwiML', async () => {
    const { body, contentType } = await twilio.control(
      'CA1',
      [
        { kind: 'say', text: 'Welcome' },
        { kind: 'collect', say: 'Press one', maxDigits: 1, timeoutSec: 5 },
        { kind: 'bridge', to: '+15550003333' },
        { kind: 'hangup' },
      ],
      account,
    );

    expect(contentType).toContain('xml');
    const xml = String(body);
    expect(xml).toContain('<Say>Welcome</Say>');
    expect(xml).toContain('<Gather numDigits="1" timeout="5"');
    expect(xml).toContain('<Dial timeout="30">+15550003333</Dial>');
    expect(xml).toContain('<Hangup/>');
  });

  it('escapes text that would otherwise break the document', async () => {
    const { body } = await twilio.control(
      'CA1',
      [{ kind: 'say', text: 'Fish & chips </Say><Hangup/>' }],
      account,
    );
    const xml = String(body);
    expect(xml).toContain('&amp;');
    expect(xml).not.toContain('</Say><Hangup/>');
  });
});

describe('SIP gateway verification', () => {
  const sipAccount: TelephonyAccount = {
    id: 'acct',
    organizationId: 'org',
    credentials: { webhookSecret: 'shared-secret', gatewayToken: 't' },
    config: { gatewayUrl: 'https://pbx.example.com' },
  };
  const rawBody = JSON.stringify({ callId: 'abc', event: 'answered' });
  const signature = createHmac('sha256', 'shared-secret').update(rawBody).digest('hex');

  it('accepts a correctly signed body', () => {
    expect(sip.verifySignature({}, { 'x-gateway-signature': signature }, sipAccount, rawBody)).toBe(
      true,
    );
  });

  it('rejects a body that was altered after signing', () => {
    expect(
      sip.verifySignature({}, { 'x-gateway-signature': signature }, sipAccount, '{"callId":"xyz"}'),
    ).toBe(false);
  });

  it('rejects when no raw body was captured to verify', () => {
    expect(sip.verifySignature({}, { 'x-gateway-signature': signature }, sipAccount)).toBe(false);
  });
});

describe('SIP event mapping', () => {
  it('understands both Asterisk and FreeSWITCH names for the same moment', async () => {
    expect((await sip.receive({ callId: 'a', event: 'StasisStart' }))?.type).toBe('initiated');
    expect((await sip.receive({ callId: 'a', event: 'CHANNEL_ANSWER' }))?.type).toBe('answered');
    expect((await sip.receive({ callId: 'a', event: 'CHANNEL_HANGUP_COMPLETE' }))?.type).toBe(
      'hangup',
    );
  });

  it('ignores an event it has no mapping for', async () => {
    expect(await sip.receive({ callId: 'a', event: 'CHANNEL_STATE' })).toBeNull();
  });
});

describe('the simulated provider', () => {
  it('reports what the caller would have heard', async () => {
    const { body } = await simulated.control('sim-1', [
      { kind: 'say', text: 'Welcome' },
      { kind: 'collect', say: 'Press one', maxDigits: 1, timeoutSec: 5 },
    ]);
    expect((body as { transcript: string[] }).transcript).toEqual([
      '[say] Welcome',
      '[collect 1 digit(s), 5s] Press one',
    ]);
  });

  it('produces a real, playable WAV so the storage path is exercised', async () => {
    const { content, contentType } = await simulated.fetchRecording('any');
    expect(contentType).toBe('audio/wav');
    expect(content.subarray(0, 4).toString()).toBe('RIFF');
    expect(content.subarray(8, 12).toString()).toBe('WAVE');
  });

  it('is honest that it cannot carry media', () => {
    expect(simulated.capabilities().supportsMediaStreaming).toBe(false);
  });

  it('ignores an event type it does not know', async () => {
    expect(await simulated.receive({ type: 'nonsense', callId: 'a' })).toBeNull();
  });
});
