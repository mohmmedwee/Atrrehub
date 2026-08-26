import { describe, expect, it } from 'vitest';
import { PRESETS, buildRequest, mapRecord, readPath, type ConnectorConfig } from './connectors';

describe('readPath', () => {
  it('reads a nested value', () => {
    expect(readPath({ properties: { email: 'ada@example.com' } }, 'properties.email')).toBe(
      'ada@example.com',
    );
  });

  it('indexes into an array', () => {
    expect(readPath({ records: [{ id: 'a' }, { id: 'b' }] }, 'records.1.id')).toBe('b');
  });

  it('returns undefined for a missing branch rather than throwing', () => {
    expect(readPath({ a: null }, 'a.b.c')).toBeUndefined();
    expect(readPath({}, 'nothing.here')).toBeUndefined();
  });

  it('returns the whole object for an empty path', () => {
    expect(readPath({ a: 1 }, '')).toEqual({ a: 1 });
  });
});

describe('mapRecord', () => {
  const mapping = PRESETS.hubspot.fieldMapping;

  it('maps a provider record onto customer fields', () => {
    const mapped = mapRecord(
      {
        id: '1201',
        properties: { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@example.com' },
      },
      mapping,
    );
    expect(mapped).toEqual({
      externalId: '1201',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    });
  });

  it('drops fields the tenant did not map', () => {
    const mapped = mapRecord(
      { id: '1', properties: { email: 'a@b.com', ssn: '123-45-6789' } },
      mapping,
    );
    expect(Object.values(mapped)).not.toContain('123-45-6789');
  });

  it('refuses a mapping onto a field that is not a customer field', () => {
    const mapped = mapRecord({ role: 'owner' }, { role: 'permissions' });
    expect(mapped).toEqual({});
  });

  it('skips empty and absent values instead of blanking the customer', () => {
    const mapped = mapRecord({ properties: { firstname: '', lastname: 'Hopper' } }, mapping);
    expect(mapped.firstName).toBeUndefined();
    expect(mapped.lastName).toBe('Hopper');
  });

  it('truncates a pathologically long value', () => {
    const mapped = mapRecord({ properties: { firstname: 'x'.repeat(5000) } }, mapping);
    expect(mapped.firstName).toHaveLength(500);
  });
});

describe('buildRequest', () => {
  const config: ConnectorConfig = {
    baseUrl: 'https://api.example.com',
    auth: 'bearer',
    contactsPath: '/contacts',
    recordsPath: 'data',
    cursorParam: 'after',
    pageSizeParam: 'limit',
    pageSize: 50,
    query: { fields: 'email,name' },
  };

  it('composes the URL, query and bearer credential', () => {
    const { url, headers } = buildRequest(config, { accessToken: 'tok' });
    expect(url).toBe('https://api.example.com/contacts?fields=email%2Cname&limit=50');
    expect(headers.authorization).toBe('Bearer tok');
  });

  it('adds the page cursor on later pages', () => {
    const { url } = buildRequest(config, { accessToken: 'tok' }, 'cursor-2');
    expect(url).toContain('after=cursor-2');
  });

  it('follows an absolute next-page URL as given', () => {
    const { url } = buildRequest(config, { accessToken: 'tok' }, 'https://api.example.com/page/2');
    expect(url).toBe('https://api.example.com/page/2');
  });

  it("prefers Salesforce's per-tenant instance URL over the preset base", () => {
    const salesforce = { ...PRESETS.salesforce.config, baseUrl: '' } as ConnectorConfig;
    const { url } = buildRequest(salesforce, {
      accessToken: 'tok',
      instanceUrl: 'https://acme.my.salesforce.com',
    });
    expect(url.startsWith('https://acme.my.salesforce.com/services/data/')).toBe(true);
  });

  it('encodes basic credentials rather than sending them in the clear', () => {
    const { headers } = buildRequest(
      { ...config, auth: 'basic' },
      { username: 'ada', password: 'secret' },
    );
    expect(headers.authorization).toBe(`Basic ${Buffer.from('ada:secret').toString('base64')}`);
  });

  it('puts an API key in the header or the query, as configured', () => {
    expect(
      buildRequest({ ...config, auth: 'api_key_header', authParam: 'x-token' }, { apiKey: 'k' })
        .headers['x-token'],
    ).toBe('k');
    expect(
      buildRequest({ ...config, auth: 'query_param', authParam: 'key' }, { apiKey: 'k' }).url,
    ).toContain('key=k');
  });
});
