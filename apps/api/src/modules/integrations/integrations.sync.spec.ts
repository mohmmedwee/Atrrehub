import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationsService } from './integrations.service';
import { PRESETS } from './connectors';

/**
 * The sync loop with its provider and its persistence faked out. What is under
 * test is the reconciliation policy — match, enrich, skip — and the pagination
 * that drives it, neither of which needs a database to be wrong.
 */
const integrationRow = {
  id: 'itg_1',
  name: 'HubSpot',
  isActive: true,
  status: 'connected',
  credentials: { accessToken: 'tok' },
  config: { ...PRESETS.hubspot.config, baseUrl: 'https://api.hubapi.com' },
  fieldMapping: PRESETS.hubspot.fieldMapping,
};

function harness(options: {
  pages: { records: unknown[]; after?: string }[];
  existing?: Record<string, { id: string; firstName?: string; company?: string }>;
}) {
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  let page = 0;

  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => {
      const current = options.pages[page];
      page += 1;
      return {
        results: current.records,
        paging: current.after ? { next: { after: current.after } } : undefined,
      };
    },
  }));
  vi.stubGlobal('fetch', fetchMock);

  const prisma = {
    db: {
      integration: {
        findFirst: async () => integrationRow,
        update: async () => integrationRow,
      },
    },
  };

  const customers = {
    findOrCreateByContact: async (_kind: string, value: string, seed: object) => {
      const known = options.existing?.[value];
      if (known) return { customer: known, created: false };
      return { customer: { id: `cus_${value}`, ...seed }, created: true };
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
    },
  };

  const service = new IntegrationsService(
    prisma as never,
    { decryptObject: (value: Record<string, unknown>) => value } as never,
    customers as never,
    { record: async () => {} } as never,
    { info: () => {}, error: () => {}, warn: () => {} } as never,
  );

  return { service, updates, fetchMock };
}

const contact = (id: string, email: string, extra: Record<string, string> = {}) => ({
  id,
  properties: { email, ...extra },
});

afterEach(() => vi.unstubAllGlobals());

describe('integration sync', () => {
  it('creates a customer for each unknown contact', async () => {
    const { service } = harness({
      pages: [{ records: [contact('1', 'ada@example.com'), contact('2', 'grace@example.com')] }],
    });

    const result = await service.sync('itg_1');
    expect(result).toMatchObject({ fetched: 2, created: 2, updated: 0, skipped: 0, pages: 1 });
  });

  it('follows the provider’s pagination', async () => {
    const { service, fetchMock } = harness({
      pages: [
        { records: [contact('1', 'ada@example.com')], after: 'p2' },
        { records: [contact('2', 'grace@example.com')] },
      ],
    });

    const result = await service.sync('itg_1');
    expect(result.pages).toBe(2);
    expect(result.fetched).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('enriches an existing customer only where the platform has nothing', async () => {
    const { service, updates } = harness({
      pages: [
        {
          records: [
            contact('1', 'ada@example.com', { firstname: 'Augusta', company: 'Analytical Ltd' }),
          ],
        },
      ],
      existing: { 'ada@example.com': { id: 'cus_ada', firstName: 'Ada' } },
    });

    const result = await service.sync('itg_1');
    expect(result.updated).toBe(1);
    // firstName was already known from a conversation and is left alone.
    expect(updates[0].patch).toEqual({ externalId: '1', company: 'Analytical Ltd' });
  });

  it('leaves an already-complete customer untouched', async () => {
    const { service, updates } = harness({
      pages: [{ records: [contact('1', 'ada@example.com', { firstname: 'Ada' })] }],
      existing: {
        'ada@example.com': { id: 'cus_ada', firstName: 'Ada', externalId: '1' } as never,
      },
    });

    const result = await service.sync('itg_1');
    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(updates).toHaveLength(0);
  });

  it('skips a record with no email or phone rather than creating an unreachable customer', async () => {
    const { service } = harness({
      pages: [{ records: [{ id: '9', properties: { firstname: 'Nobody' } }] }],
    });

    const result = await service.sync('itg_1');
    expect(result).toMatchObject({ fetched: 1, created: 0, skipped: 1 });
  });

  it('refuses to call a private address', async () => {
    const { service } = harness({ pages: [{ records: [] }] });
    (integrationRow.config as { baseUrl: string }).baseUrl = 'http://169.254.169.254';

    await expect(service.sync('itg_1')).rejects.toThrow(/unavailable|private|link-local/i);
    (integrationRow.config as { baseUrl: string }).baseUrl = 'https://api.hubapi.com';
  });
});
