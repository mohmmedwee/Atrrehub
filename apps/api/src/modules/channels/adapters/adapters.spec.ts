import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChannelAccountContext } from '../channel-adapter';
import { InstagramAdapter } from './instagram.adapter';
import { MessengerAdapter } from './messenger.adapter';
import { SmsAdapter } from './sms.adapter';
import { TeamsAdapter } from './teams.adapter';
import { TelegramAdapter } from './telegram.adapter';
import { WhatsAppAdapter } from './whatsapp.adapter';

const logger = { error: () => {}, warn: () => {}, info: () => {} } as never;

const whatsapp = new WhatsAppAdapter(logger);
const messenger = new MessengerAdapter(logger);
const instagram = new InstagramAdapter(logger);
const sms = new SmsAdapter(logger);
const telegram = new TelegramAdapter(logger);
const teams = new TeamsAdapter(logger);

const account = (
  credentials: Record<string, unknown>,
  config: Record<string, unknown> = {},
): ChannelAccountContext => ({
  id: 'cha_1',
  organizationId: 'org_1',
  credentials,
  config,
});

/**
 * Every one of these channels delivers over a public, unauthenticated URL.
 * Without verification anyone who learns the endpoint can inject a message
 * into a tenant's inbox as any customer they choose, so the refusals below
 * matter more than the happy paths.
 */
describe('Meta signature verification', () => {
  const secret = 'app-secret';
  const body = JSON.stringify({ entry: [{ id: '1' }] });
  const signature = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  const meta = account({ appSecret: secret });

  it('accepts a correctly signed body', () => {
    expect(whatsapp.verifySignature({}, { 'x-hub-signature-256': signature }, meta, body)).toBe(
      true,
    );
  });

  it('rejects a body altered after signing', () => {
    expect(
      whatsapp.verifySignature({}, { 'x-hub-signature-256': signature }, meta, '{"entry":[]}'),
    ).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(whatsapp.verifySignature({}, {}, meta, body)).toBe(false);
  });

  it('rejects a signature without the sha256 prefix', () => {
    const bare = signature.slice(7);
    expect(whatsapp.verifySignature({}, { 'x-hub-signature-256': bare }, meta, body)).toBe(false);
  });

  it('rejects when the account has no app secret to verify against', () => {
    expect(
      whatsapp.verifySignature({}, { 'x-hub-signature-256': signature }, account({}), body),
    ).toBe(false);
  });

  it('rejects when no raw body was captured', () => {
    expect(whatsapp.verifySignature({}, { 'x-hub-signature-256': signature }, meta)).toBe(false);
  });

  it('applies to every Meta platform, not just WhatsApp', () => {
    for (const adapter of [messenger, instagram]) {
      expect(adapter.verifySignature({}, { 'x-hub-signature-256': signature }, meta, body)).toBe(
        true,
      );
      expect(adapter.verifySignature({}, { 'x-hub-signature-256': signature }, meta, '{}')).toBe(
        false,
      );
    }
  });
});

describe('Meta subscription challenge', () => {
  const meta = account({ verifyToken: 'expected-token' });

  it('echoes the challenge when the token matches', () => {
    expect(
      whatsapp.challenge(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'expected-token', 'hub.challenge': '12345' },
        meta,
      ),
    ).toBe('12345');
  });

  it('refuses a wrong token', () => {
    expect(
      whatsapp.challenge(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'guess', 'hub.challenge': '12345' },
        meta,
      ),
    ).toBeNull();
  });

  it('refuses when the account has no verify token', () => {
    expect(
      whatsapp.challenge(
        { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' },
        account({}),
      ),
    ).toBeNull();
  });
});

describe('WhatsApp', () => {
  it('normalizes an inbound text message', async () => {
    const result = await whatsapp.receive({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '555' },
                contacts: [{ wa_id: '962790001234', profile: { name: 'Ada' } }],
                messages: [
                  {
                    id: 'wamid.1',
                    from: '962790001234',
                    timestamp: '1767225600',
                    type: 'text',
                    text: { body: 'my order is late' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      externalId: 'wamid.1',
      threadKey: 'whatsapp:962790001234',
      body: 'my order is late',
      contact: { kind: 'whatsapp', value: '962790001234', displayName: 'Ada' },
    });
  });

  it('carries an attachment through as a reference', async () => {
    const result = await whatsapp.receive({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'wamid.2', from: '9627900', type: 'image', image: { id: 'media-99' } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(result?.attachments?.[0]).toMatchObject({
      reference: 'media-99',
      contentType: 'image/jpeg',
    });
  });

  it('ignores a status-only webhook', async () => {
    expect(
      await whatsapp.receive({ entry: [{ changes: [{ value: { statuses: [] } }] }] }),
    ).toBeNull();
  });

  describe('the 24-hour session window', () => {
    it('is open just inside 24 hours', () => {
      const now = new Date('2026-03-02T12:00:00Z');
      const lastInbound = new Date('2026-03-01T12:30:00Z');
      expect(WhatsAppAdapter.isWithinSessionWindow(lastInbound, now)).toBe(true);
    });

    it('is closed just outside', () => {
      const now = new Date('2026-03-02T12:00:00Z');
      const lastInbound = new Date('2026-03-01T11:30:00Z');
      expect(WhatsAppAdapter.isWithinSessionWindow(lastInbound, now)).toBe(false);
    });

    it('is closed when the customer has never written', () => {
      expect(WhatsAppAdapter.isWithinSessionWindow(null)).toBe(false);
    });

    it('refuses a late free-form reply rather than losing it silently', async () => {
      const receipt = await whatsapp.send(
        {
          conversationId: 'cnv_1',
          messageId: 'msg_1',
          to: '9627900',
          body: 'sorry for the delay',
          metadata: { lastInboundAt: '2020-01-01T00:00:00Z' },
        },
        account({ accessToken: 'tok' }, { phoneNumberId: '555' }),
      );
      expect(receipt.state).toBe('failed');
      expect(receipt.error).toContain('template');
    });
  });

  it('advertises its session window so the workspace can warn an agent', () => {
    expect(whatsapp.metadata().sessionWindowHours).toBe(24);
  });
});

describe('Messenger', () => {
  it('normalizes an inbound message', async () => {
    const result = await messenger.receive({
      entry: [
        {
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: 'page-1' },
              timestamp: 1767225600000,
              message: { mid: 'mid.1', text: 'hello' },
            },
          ],
        },
      ],
    });
    expect(result).toMatchObject({
      externalId: 'mid.1',
      body: 'hello',
      threadKey: 'messenger:psid-1',
    });
  });

  it('ignores the page’s own echoed messages', async () => {
    const result = await messenger.receive({
      entry: [
        {
          messaging: [
            { sender: { id: 'page-1' }, message: { mid: 'mid.2', text: 'hi', is_echo: true } },
          ],
        },
      ],
    });
    expect(result).toBeNull();
  });
});

describe('Instagram', () => {
  it('gives a story reply readable text rather than an empty message', async () => {
    const result = await instagram.receive({
      entry: [
        {
          messaging: [
            {
              sender: { id: 'ig-1', username: 'ada' },
              message: { mid: 'mid.3', reply_to: { story: { id: 's1' } } },
            },
          ],
        },
      ],
    });
    expect(result?.body).toContain('story');
    expect(result?.contact.displayName).toBe('ada');
  });

  it('describes bare attachments rather than sending an empty body', async () => {
    const result = await instagram.receive({
      entry: [
        {
          messaging: [
            {
              sender: { id: 'ig-2' },
              message: { mid: 'mid.4', attachments: [{ type: 'image' }, { type: 'image' }] },
            },
          ],
        },
      ],
    });
    expect(result?.body).toBe('(sent 2 attachments)');
  });
});

describe('SMS', () => {
  describe('segment counting', () => {
    it('counts a short GSM-7 message as one segment', () => {
      expect(SmsAdapter.segments('Your order has shipped.')).toBe(1);
    });

    it('counts 160 GSM-7 characters as one and 161 as two', () => {
      expect(SmsAdapter.segments('a'.repeat(160))).toBe(1);
      expect(SmsAdapter.segments('a'.repeat(161))).toBe(2);
    });

    it('halves the limit once a single emoji forces UCS-2', () => {
      expect(SmsAdapter.isGsm7('Thanks! 🙂')).toBe(false);
      expect(SmsAdapter.segments('a'.repeat(70))).toBe(1);
      expect(SmsAdapter.segments(`${'a'.repeat(70)}🙂`)).toBeGreaterThan(1);
    });

    it('charges two septets for an extended character', () => {
      expect(SmsAdapter.segments('a'.repeat(159) + '€')).toBe(2);
    });

    it('counts an empty body as nothing', () => {
      expect(SmsAdapter.segments('')).toBe(0);
    });
  });

  it('refuses a body that would become an absurd number of segments', async () => {
    const receipt = await sms.send(
      { conversationId: 'c', messageId: 'm', to: '+15550001111', body: 'a'.repeat(5000) },
      account({ accountSid: 'AC', authToken: 't' }, { fromNumber: '+15550002222' }),
    );
    expect(receipt.state).toBe('failed');
    expect(receipt.error).toContain('segments');
  });

  it('normalizes an inbound message with media', async () => {
    const result = await sms.receive({
      MessageSid: 'SM1',
      From: '+962790001234',
      To: '+15550002222',
      Body: 'help',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/1',
      MediaContentType0: 'image/png',
    });
    expect(result).toMatchObject({ externalId: 'SM1', body: 'help' });
    expect(result?.attachments?.[0]).toMatchObject({ contentType: 'image/png' });
  });

  it('verifies a Twilio signature and rejects a tampered parameter', () => {
    const url = 'https://app.example.com/api/v1/channels/webhooks/sms';
    const params = { MessageSid: 'SM1', From: '+1555', Body: 'hi' };
    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key as keyof typeof params], url);
    const signature = createHmac('sha1', 'auth-token')
      .update(Buffer.from(data, 'utf8'))
      .digest('base64');
    const twilio = account({ authToken: 'auth-token' }, { webhookUrl: url });

    expect(sms.verifySignature(params, { 'x-twilio-signature': signature }, twilio)).toBe(true);
    expect(
      sms.verifySignature(
        { ...params, Body: 'tampered' },
        { 'x-twilio-signature': signature },
        twilio,
      ),
    ).toBe(false);
  });
});

describe('Telegram', () => {
  it('normalizes an inbound message and keys the thread by chat', async () => {
    const result = await telegram.receive({
      update_id: 9,
      message: {
        message_id: 42,
        date: 1767225600,
        text: 'where is my order',
        chat: { id: 12345 },
        from: { id: 12345, first_name: 'Ada', last_name: 'Lovelace', username: 'ada' },
      },
    });

    expect(result).toMatchObject({
      // Telegram message ids are unique per chat, not globally.
      externalId: '12345:42',
      threadKey: 'telegram:12345',
      body: 'where is my order',
      contact: { kind: 'telegram', value: '12345', displayName: 'Ada Lovelace' },
    });
  });

  it('takes the largest of the photo sizes Telegram offers', async () => {
    const result = await telegram.receive({
      message: {
        message_id: 1,
        chat: { id: 1 },
        photo: [{ file_id: 'small' }, { file_id: 'medium' }, { file_id: 'large' }],
      },
    });
    expect(result?.attachments?.[0].reference).toBe('large');
  });

  it('ignores an update that carries no message', async () => {
    expect(await telegram.receive({ update_id: 1 })).toBeNull();
  });

  it('accepts the right secret token and refuses everything else', () => {
    const tg = account({ webhookSecret: 'shhh' });
    expect(telegram.verifySignature({}, { 'x-telegram-bot-api-secret-token': 'shhh' }, tg)).toBe(
      true,
    );
    expect(telegram.verifySignature({}, { 'x-telegram-bot-api-secret-token': 'wrong' }, tg)).toBe(
      false,
    );
    expect(telegram.verifySignature({}, {}, tg)).toBe(false);
    expect(
      telegram.verifySignature({}, { 'x-telegram-bot-api-secret-token': 'shhh' }, account({})),
    ).toBe(false);
  });
});

describe('Teams', () => {
  it('normalizes a message activity', async () => {
    const result = await teams.receive({
      id: 'act-1',
      type: 'message',
      text: 'need help',
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      from: { id: '29:abc', name: 'Ada', aadObjectId: 'aad-1' },
      conversation: { id: 'conv-1' },
    });

    expect(result).toMatchObject({
      externalId: 'act-1',
      threadKey: 'teams:conv-1',
      body: 'need help',
      contact: { value: 'aad-1', displayName: 'Ada' },
    });
    // The reply URL is per-tenant, so it must survive the normalization.
    expect(result?.metadata?.serviceUrl).toBe('https://smba.trafficmanager.net/emea/');
  });

  it.each(['conversationUpdate', 'typing', 'messageReaction'])(
    'ignores a %s activity',
    async (type) => {
      expect(await teams.receive({ id: 'a', type, from: { id: '1' } })).toBeNull();
    },
  );

  it('refuses inbound traffic when no shared secret is configured', () => {
    expect(teams.verifySignature({}, { authorization: 'Bearer anything' }, account({}))).toBe(
      false,
    );
  });

  it('accepts the configured shared secret', () => {
    const configured = account({ sharedSecret: 's3cret' });
    expect(teams.verifySignature({}, { authorization: 'Bearer s3cret' }, configured)).toBe(true);
    expect(teams.verifySignature({}, { authorization: 'Bearer nope' }, configured)).toBe(false);
  });
});

describe('channel metadata', () => {
  it('reports a message limit for every channel', () => {
    for (const adapter of [whatsapp, messenger, instagram, sms, telegram, teams]) {
      expect(adapter.metadata().maxMessageLength).toBeGreaterThan(0);
    }
  });
});
