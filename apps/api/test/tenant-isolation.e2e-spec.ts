import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContextStore } from '../src/core/context/request-context';
import { closeTestApp, createTestApp, registerTenant, type TestContext } from './setup';

/**
 * The isolation guarantee, tested the only way that means anything: two real
 * tenants, real requests, real database.
 *
 * Every one of these would be a critical incident in production, so they run
 * against the whole stack rather than a mocked query layer.
 */
describe('tenant isolation', () => {
  let context: TestContext;
  let alpha: Awaited<ReturnType<typeof registerTenant>>;
  let beta: Awaited<ReturnType<typeof registerTenant>>;
  let alphaCustomerId: string;
  let alphaConversationId: string;

  beforeAll(async () => {
    context = await createTestApp();
    alpha = await registerTenant(context, 'alpha');
    beta = await registerTenant(context, 'beta');

    const customer = await context.request('POST', '/customers', {
      token: alpha.token,
      body: {
        firstName: 'Alpha',
        lastName: 'Customer',
        contactMethods: [{ kind: 'email', value: `alpha-${Date.now()}@example.test` }],
      },
    });
    alphaCustomerId = customer.body.data.id;

    const conversation = await context.request('POST', '/conversations', {
      token: alpha.token,
      body: { channel: 'api', customerId: alphaCustomerId, subject: 'Alpha private matter' },
    });
    alphaConversationId = conversation.body.data.id;
  }, 60_000);

  afterAll(async () => {
    if (context) await closeTestApp(context);
  });

  it('registers two distinct organizations', () => {
    expect(alpha.organizationId).not.toBe(beta.organizationId);
  });

  it('does not leak a customer across tenants', async () => {
    const own = await context.request('GET', `/customers/${alphaCustomerId}`, {
      token: alpha.token,
    });
    expect(own.status).toBe(200);

    const foreign = await context.request('GET', `/customers/${alphaCustomerId}`, {
      token: beta.token,
    });
    // 404 rather than 403: existence must not be disclosed across the boundary.
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('not_found');
  });

  it('does not leak a conversation across tenants', async () => {
    const foreign = await context.request('GET', `/conversations/${alphaConversationId}`, {
      token: beta.token,
    });
    expect(foreign.status).toBe(404);
  });

  it('does not leak conversation messages across tenants', async () => {
    const foreign = await context.request('GET', `/conversations/${alphaConversationId}/messages`, {
      token: beta.token,
    });
    expect(foreign.status).toBe(404);
  });

  it('excludes another tenant’s records from list endpoints', async () => {
    const customers = await context.request('GET', '/customers?limit=100', { token: beta.token });
    expect(customers.status).toBe(200);
    expect(customers.body.data.map((row: { id: string }) => row.id)).not.toContain(alphaCustomerId);

    const conversations = await context.request('GET', '/conversations?limit=100', {
      token: beta.token,
    });
    expect(conversations.body.data.map((row: { id: string }) => row.id)).not.toContain(
      alphaConversationId,
    );
  });

  it('refuses to write to another tenant’s record', async () => {
    const update = await context.request('PATCH', `/customers/${alphaCustomerId}`, {
      token: beta.token,
      body: { company: 'Hijacked' },
    });
    expect([404, 403]).toContain(update.status);

    // …and the record is genuinely untouched.
    const check = await context.request('GET', `/customers/${alphaCustomerId}`, {
      token: alpha.token,
    });
    expect(check.body.data.company).not.toBe('Hijacked');
  });

  it('refuses to delete another tenant’s record', async () => {
    const removed = await context.request('DELETE', `/customers/${alphaCustomerId}`, {
      token: beta.token,
    });
    expect([404, 403]).toContain(removed.status);

    const check = await context.request('GET', `/customers/${alphaCustomerId}`, {
      token: alpha.token,
    });
    expect(check.status).toBe(200);
  });

  it('ignores a forged organization header', async () => {
    const forged = await context.request('GET', `/customers/${alphaCustomerId}`, {
      token: beta.token,
      headers: { 'x-organization-id': alpha.organizationId },
    });
    // The tenant comes from the signed token, never from a header.
    expect([403, 404]).toContain(forged.status);
  });

  it('scopes queues, knowledge bases and agents to their own tenant', async () => {
    for (const path of ['/queues', '/knowledge/bases', '/agents']) {
      const alphaRows = await context.request('GET', path, { token: alpha.token });
      const betaRows = await context.request('GET', path, { token: beta.token });
      expect(alphaRows.status).toBe(200);
      expect(betaRows.status).toBe(200);

      const alphaIds = new Set((alphaRows.body.data ?? []).map((row: { id: string }) => row.id));
      for (const row of betaRows.body.data ?? []) {
        expect(alphaIds.has(row.id), `${path} leaked ${row.id}`).toBe(false);
      }
    }
  });

  it('refuses a tenant-scoped query issued with no organization in scope', async () => {
    // The guard must fail loudly rather than reading across every tenant.
    await expect(
      RequestContextStore.run({ requestId: 'test-no-tenant', startedAt: Date.now() }, async () =>
        context.prisma.db.customer.findMany({}),
      ),
    ).rejects.toThrow(/organization context/i);
  });

  it('still allows deliberate cross-tenant work for platform jobs', async () => {
    // The outbox relay and retention sweeps legitimately span tenants.
    const count = await RequestContextStore.runAsSystem(() => context.prisma.db.customer.count());
    expect(count).toBeGreaterThanOrEqual(1);
  });
  it('does not deliver one tenant’s events to another tenant’s webhook', async () => {
    // The fan-out reads endpoints with the unguarded client, because it runs
    // from a listener that may have no request in scope — so the scoping is a
    // filter in the query rather than the guard, and it is worth proving.
    const betaEndpoint = await context.request('POST', '/webhooks', {
      token: beta.token,
      body: {
        name: 'Beta listener',
        url: 'http://localhost:9/never-listening',
        events: ['*'],
      },
    });
    expect(betaEndpoint.status).toBe(201);
    const betaEndpointId = betaEndpoint.body.data.id;

    // Alpha does something that publishes events.
    const conversation = await context.request('POST', '/conversations', {
      token: alpha.token,
      body: { channel: 'api', customerId: alphaCustomerId, subject: 'Alpha event source' },
    });
    expect(conversation.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 750));

    const betaDeliveries = await context.request('GET', '/webhooks/deliveries', {
      token: beta.token,
    });
    expect(betaDeliveries.status).toBe(200);
    expect(betaDeliveries.body.data).toEqual([]);

    // And beta cannot see, replay or delete alpha's endpoints either.
    const alphaEndpoint = await context.request('POST', '/webhooks', {
      token: alpha.token,
      body: { name: 'Alpha listener', url: 'http://localhost:9/hook', events: ['*'] },
    });
    expect(alphaEndpoint.status).toBe(201);

    const foreign = await context.request('GET', `/webhooks/${alphaEndpoint.body.data.id}`, {
      token: beta.token,
    });
    expect(foreign.status).toBe(404);

    const betaList = await context.request('GET', '/webhooks', { token: beta.token });
    expect(betaList.body.data.map((row: { id: string }) => row.id)).toEqual([betaEndpointId]);
  });

  it('never returns a webhook signing secret after it is created', async () => {
    const created = await context.request('POST', '/webhooks', {
      token: alpha.token,
      body: { name: 'Secret check', url: 'http://localhost:9/hook', events: ['ticket.created'] },
    });
    expect(created.body.data.secret).toMatch(/^whsec_/);

    const read = await context.request('GET', `/webhooks/${created.body.data.id}`, {
      token: alpha.token,
    });
    expect(read.body.data.secret).toBeUndefined();
    expect(read.body.data.secretSet).toBe(true);

    const listed = await context.request('GET', '/webhooks', { token: alpha.token });
    expect(JSON.stringify(listed.body)).not.toContain('whsec_');
  });
});
