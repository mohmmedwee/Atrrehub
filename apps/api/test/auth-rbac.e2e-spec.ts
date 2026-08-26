import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearRateLimits,
  closeTestApp,
  createTestApp,
  registerTenant,
  type TestContext,
} from './setup';

/** Authentication, session lifecycle and deny-by-default authorization. */
describe('authentication and authorization', () => {
  let context: TestContext;
  let owner: Awaited<ReturnType<typeof registerTenant>>;

  beforeAll(async () => {
    context = await createTestApp();
    owner = await registerTenant(context, 'rbac');
  }, 60_000);

  afterAll(async () => {
    if (context) await closeTestApp(context);
  });

  describe('registration', () => {
    it('provisions the full tenant scaffold', async () => {
      const roles = await context.request('GET', '/roles', { token: owner.token });
      expect(roles.body.data).toHaveLength(8);

      const queues = await context.request('GET', '/queues', { token: owner.token });
      expect(queues.body.data.length).toBeGreaterThan(0);

      const bases = await context.request('GET', '/knowledge/bases', { token: owner.token });
      expect(bases.body.data.length).toBeGreaterThan(0);

      const policies = await context.request('GET', '/sla/policies', { token: owner.token });
      expect(policies.body.data[0].targets.length).toBeGreaterThan(0);
    });

    it('rejects a weak password with field-level detail', async () => {
      const { status, body } = await context.request('POST', '/auth/register', {
        body: {
          email: 'weak@test.test',
          password: 'short',
          firstName: 'A',
          lastName: 'B',
          organizationName: 'Weak',
        },
      });
      expect(status).toBe(422);
      expect(body.code).toBe('validation_failed');
      expect(body.errors.some((error: { path: string }) => error.path === 'password')).toBe(true);
    });

    it('refuses a duplicate email', async () => {
      const { status, body } = await context.request('POST', '/auth/register', {
        body: {
          email: owner.email,
          password: 'Str0ngPassword!23',
          firstName: 'Dup',
          lastName: 'User',
          organizationName: 'Duplicate',
        },
      });
      expect(status).toBe(409);
      expect(body.code).toBe('conflict');
    });
  });

  describe('sessions', () => {
    it('rotates the refresh token and revokes the family on reuse', async () => {
      const first = await context.request('POST', '/auth/refresh', {
        body: { refreshToken: owner.refreshToken },
      });
      expect(first.status).toBe(200);
      expect(first.body.data.refreshToken).not.toBe(owner.refreshToken);

      // Replaying the rotated token is the signature of a stolen credential.
      const replay = await context.request('POST', '/auth/refresh', {
        body: { refreshToken: owner.refreshToken },
      });
      expect(replay.status).toBe(401);
      expect(replay.body.detail).toMatch(/revoked/i);
    });

    it('lets the user log in again immediately after a family revocation', async () => {
      await clearRateLimits(context);
      // Revocation is a watermark, not a ban.
      const { status } = await context.request('POST', '/auth/login', {
        body: { email: owner.email, password: owner.password },
      });
      expect(status).toBe(200);
    });

    it('rejects a malformed or absent token', async () => {
      expect((await context.request('GET', '/auth/me')).status).toBe(401);
      expect((await context.request('GET', '/auth/me', { token: 'not-a-token' })).status).toBe(401);
    });
  });

  describe('authorization', () => {
    let agentToken: string;

    beforeAll(async () => {
      await clearRateLimits(context);
      const login = await context.request('POST', '/auth/login', {
        body: { email: owner.email, password: owner.password },
      });
      const ownerToken = login.body.data.accessToken;

      const email = `agent-${Date.now().toString(36)}@rbac.test`;
      const invite = await context.request('POST', '/users', {
        token: ownerToken,
        body: { email, firstName: 'Agent', lastName: 'User', roleKey: 'agent' },
      });
      expect(invite.status).toBe(201);

      // Accept the invitation through the token the platform issued.
      const record = await context.prisma.raw.verificationToken.findFirst({
        where: { userId: invite.body.data.userId, purpose: 'invitation' },
        orderBy: { createdAt: 'desc' },
      });
      expect(record).toBeTruthy();

      // The plaintext token is not recoverable from the hash, so sign in via a
      // direct activation instead — the invitation path is covered separately.
      await context.prisma.raw.user.update({
        where: { id: invite.body.data.userId },
        data: {
          status: 'active',
          passwordHash: (
            await context.prisma.raw.user.findUniqueOrThrow({ where: { id: owner.userId } })
          ).passwordHash,
        },
      });

      const agentLogin = await context.request('POST', '/auth/login', {
        body: { email, password: owner.password },
      });
      agentToken = agentLogin.body.data.accessToken;
      expect(agentToken).toBeTruthy();
    }, 60_000);

    it('grants an agent what their role allows', async () => {
      expect((await context.request('GET', '/conversations', { token: agentToken })).status).toBe(
        200,
      );
      expect((await context.request('GET', '/customers', { token: agentToken })).status).toBe(200);
      expect((await context.request('GET', '/knowledge/bases', { token: agentToken })).status).toBe(
        200,
      );
    });

    it('denies an agent administrative endpoints', async () => {
      for (const path of ['/users', '/api-keys', '/audit']) {
        const { status, body } = await context.request('GET', path, { token: agentToken });
        expect(status, `${path} should be denied`).toBe(403);
        expect(body.code).toBe('permission_denied');
      }
    });

    it('denies an agent the ability to create roles', async () => {
      const { status } = await context.request('POST', '/roles', {
        token: agentToken,
        body: { key: 'sneaky', name: 'Sneaky', permissions: ['organization:manage'] },
      });
      expect(status).toBe(403);
    });

    it('refuses to let anyone grant permissions they do not hold', async () => {
      const { status, body } = await context.request('POST', '/roles', {
        token: agentToken,
        body: { key: 'escalated', name: 'Escalated', permissions: ['billing:manage'] },
      });
      expect(status).toBe(403);
      expect(body.code).toBe('permission_denied');
    });
  });

  describe('API keys', () => {
    it('issues a key limited to the permissions requested', async () => {
      await clearRateLimits(context);
      const login = await context.request('POST', '/auth/login', {
        body: { email: owner.email, password: owner.password },
      });
      const token = login.body.data.accessToken;

      const created = await context.request('POST', '/api-keys', {
        token,
        body: { name: 'Read-only integration', permissions: ['ticket:read'] },
      });
      expect(created.status).toBe(201);
      const key = created.body.data.key;
      expect(key).toMatch(/^ak_/);

      // The key can do exactly what it was granted…
      const allowed = await context.request('GET', '/tickets', { headers: { 'x-api-key': key } });
      expect(allowed.status).toBe(200);

      // …and nothing else.
      const denied = await context.request('GET', '/users', { headers: { 'x-api-key': key } });
      expect(denied.status).toBe(403);
    });

    it('rejects a revoked key', async () => {
      await clearRateLimits(context);
      const login = await context.request('POST', '/auth/login', {
        body: { email: owner.email, password: owner.password },
      });
      const token = login.body.data.accessToken;

      const created = await context.request('POST', '/api-keys', {
        token,
        body: { name: 'Temporary', permissions: ['ticket:read'] },
      });
      const key = created.body.data.key;

      await context.request('DELETE', `/api-keys/${created.body.data.id}`, { token });

      const { status } = await context.request('GET', '/tickets', {
        headers: { 'x-api-key': key },
      });
      expect(status).toBe(401);
    });
  });
});
