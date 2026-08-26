import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { isEgressAllowed } from '../guardrails/detectors';
import {
  buildAuthorizationUrl,
  createPkcePair,
  groupsFromClaims,
  profileFromClaims,
  resolveRole,
  verifyIdToken,
  type Jwk,
  type OidcConfig,
} from './oidc';
import { randomBytes } from 'node:crypto';

export interface GroupRoleRule {
  group: string;
  roleKey: string;
}

export interface SsoConnectionInput {
  domain: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  groupsClaim?: string;
  /** Ordered: the first matching group wins. */
  groupRoleMapping?: GroupRoleRule[];
  /** Role for a user matching no group. Absent means such a user is refused. */
  defaultRoleKey?: string;
  /** Whether an unknown user may be created on first sign-in. */
  allowJitProvisioning?: boolean;
}

interface StoredConfig extends Omit<SsoConnectionInput, 'domain' | 'clientSecret'> {
  clientSecret: string;
  scimTokenHash?: string;
}

/** A login that has not completed inside this window is abandoned. */
const LOGIN_TTL_SECONDS = 600;
const JWKS_CACHE_SECONDS = 900;

@Injectable()
export class SsoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  // ── Connections ────────────────────────────────────────────────────────────

  async list() {
    const connections = await this.prisma.db.ssoConnection.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return connections.map((connection) => this.redact(connection));
  }

  async get(connectionId: string) {
    return this.redact(await this.load(connectionId));
  }

  async create(input: SsoConnectionInput) {
    const domain = this.normalizeDomain(input.domain);
    await this.validateEndpoints(input);
    await this.validateRoles(input);

    const organizationId = RequestContextStore.organizationId()!;
    const clash = await this.prisma.db.ssoConnection.findFirst({ where: { domain } });
    if (clash) throw AppError.conflict(`${domain} is already routed to an SSO connection`);

    const connection = await this.prisma.db.ssoConnection.create({
      data: {
        id: newId('sso'),
        organizationId,
        kind: 'oidc',
        domain,
        config: this.packConfig(input) as unknown as Prisma.InputJsonValue,
        isEnabled: false,
      },
    });

    await this.audit.record({
      action: 'sso.connection_created',
      resourceType: 'sso_connection',
      resourceId: connection.id,
      after: { domain, issuer: input.issuer },
    });

    return this.redact(connection);
  }

  async update(connectionId: string, patch: Partial<SsoConnectionInput>) {
    const connection = await this.load(connectionId);
    const config = this.configOf(connection);
    const merged = { ...config, ...patch } as SsoConnectionInput;

    if (patch.issuer || patch.authorizationEndpoint || patch.tokenEndpoint || patch.jwksUri)
      await this.validateEndpoints(merged);
    if (patch.groupRoleMapping || patch.defaultRoleKey) await this.validateRoles(merged);

    const updated = await this.prisma.db.ssoConnection.update({
      where: { id: connectionId },
      data: {
        ...(patch.domain ? { domain: this.normalizeDomain(patch.domain) } : {}),
        config: {
          ...this.packConfig(merged),
          // A rotation of the SCIM token is a separate, explicit action.
          scimTokenHash: config.scimTokenHash,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // Changing the JWKS URI must not leave the old keys cached.
    if (patch.jwksUri) await this.redis.del(this.jwksKey(connectionId));

    return this.redact(updated);
  }

  async setEnabled(connectionId: string, isEnabled: boolean) {
    const connection = await this.load(connectionId);
    if (isEnabled) {
      // Enabling routes a whole email domain away from passwords: the keys
      // must be reachable first, or every user at that domain is locked out.
      await this.fetchJwks(connection.id, this.configOf(connection).jwksUri, true);
    }

    const updated = await this.prisma.db.ssoConnection.update({
      where: { id: connectionId },
      data: { isEnabled },
    });
    await this.audit.record({
      action: isEnabled ? 'sso.connection_enabled' : 'sso.connection_disabled',
      resourceType: 'sso_connection',
      resourceId: connectionId,
    });
    return this.redact(updated);
  }

  async delete(connectionId: string) {
    await this.load(connectionId);
    await this.prisma.db.ssoConnection.delete({ where: { id: connectionId } });
    await this.redis.del(this.jwksKey(connectionId));
    await this.audit.record({
      action: 'sso.connection_deleted',
      resourceType: 'sso_connection',
      resourceId: connectionId,
    });
  }

  /** Issue a SCIM bearer token. Shown once — only its hash is stored. */
  async rotateScimToken(connectionId: string) {
    const connection = await this.load(connectionId);
    const token = `scim_${this.crypto.randomToken(32)}`;

    await this.prisma.db.ssoConnection.update({
      where: { id: connectionId },
      data: {
        config: {
          ...this.configOf(connection),
          clientSecret: (connection.config as Record<string, unknown>).clientSecret as string,
          scimTokenHash: this.crypto.hashToken(token),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.record({
      action: 'sso.scim_token_rotated',
      resourceType: 'sso_connection',
      resourceId: connectionId,
    });

    return { token, note: 'This token is shown once. Store it in your identity provider now.' };
  }

  // ── Discovery & login ──────────────────────────────────────────────────────

  /**
   * Which connection, if any, owns an email address's domain.
   *
   * Deliberately says nothing about whether the *user* exists: a login page
   * that reveals which addresses are enrolled is an account enumeration
   * oracle, and the domain alone is what routing needs.
   */
  async discover(email: string): Promise<{ sso: boolean; connectionId?: string; domain?: string }> {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return { sso: false };

    const connection = await this.prisma.raw.ssoConnection.findFirst({
      where: { domain, isEnabled: true },
      select: { id: true, domain: true },
    });
    return connection
      ? { sso: true, connectionId: connection.id, domain: connection.domain }
      : { sso: false };
  }

  /** Begin a login: mint state, nonce and a PKCE pair, and hand back the redirect. */
  async begin(connectionId: string, redirectUri: string): Promise<{ url: string; state: string }> {
    const connection = await this.prisma.raw.ssoConnection.findFirst({
      where: { id: connectionId, isEnabled: true },
    });
    if (!connection) throw AppError.notFound('SSO connection', connectionId);

    const config = this.configOf(connection);
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const { verifier, challenge } = createPkcePair();

    await this.redis.set(
      `sso:login:${state}`,
      { connectionId, nonce, verifier, redirectUri, organizationId: connection.organizationId },
      LOGIN_TTL_SECONDS,
    );

    return {
      url: buildAuthorizationUrl(config as OidcConfig, { redirectUri, state, nonce, challenge }),
      state,
    };
  }

  /**
   * Complete a login: exchange the code, verify the ID token, then provision.
   *
   * The state is consumed before anything else happens, so a replayed callback
   * finds nothing to complete.
   */
  async complete(state: string, code: string) {
    const pending = await this.redis.get<{
      connectionId: string;
      nonce: string;
      verifier: string;
      redirectUri: string;
      organizationId: string;
    }>(`sso:login:${state}`);
    if (!pending) throw AppError.unauthenticated('This login has expired or was already completed');
    await this.redis.del(`sso:login:${state}`);

    const connection = await this.prisma.raw.ssoConnection.findFirst({
      where: { id: pending.connectionId, isEnabled: true },
    });
    if (!connection) throw AppError.unauthenticated('That SSO connection is no longer enabled');

    const config = this.configOf(connection);
    const idToken = await this.exchangeCode(config, code, pending.redirectUri, pending.verifier);
    const claims = await this.verify(connection.id, config, idToken, pending.nonce);

    const profile = profileFromClaims(claims);
    if (!profile.email)
      throw AppError.unauthenticated('The identity provider returned no email address');

    // The provider may assert any address; only one inside the domain this
    // connection owns may be used, or one tenant's IdP could mint a session
    // for another tenant's user.
    if (profile.email.split('@')[1] !== connection.domain)
      throw AppError.unauthenticated(
        `This connection signs in ${connection.domain} addresses; the provider returned ${profile.email.split('@')[1]}`,
      );

    const groups = groupsFromClaims(claims, config.groupsClaim);
    const roleKey = resolveRole(groups, config.groupRoleMapping ?? [], config.defaultRoleKey);

    return RequestContextStore.runAsSystem(async () => {
      const userId = await this.provision(connection.organizationId, {
        email: profile.email!,
        firstName: profile.firstName,
        lastName: profile.lastName,
        roleKey,
        allowJit: config.allowJitProvisioning ?? true,
      });

      await this.audit.record({
        action: 'auth.sso_login',
        resourceType: 'user',
        resourceId: userId,
        organizationId: connection.organizationId,
        actorId: userId,
        after: { connectionId: connection.id, groups, roleKey },
      });

      return this.auth.completeFederatedLogin(userId, connection.organizationId);
    }, connection.organizationId);
  }

  /**
   * Find or create the user, and keep their role in step with the provider.
   *
   * The identity provider is the authority on who works here and what they
   * are: a group removed there takes effect at the next sign-in rather than
   * waiting for someone to remember to change it here too.
   */
  private async provision(
    organizationId: string,
    input: {
      email: string;
      firstName: string;
      lastName: string;
      roleKey?: string;
      allowJit: boolean;
    },
  ): Promise<string> {
    const existing = await this.prisma.raw.user.findUnique({
      where: { email: input.email },
      include: { memberships: { where: { organizationId }, include: { role: true } } },
    });

    if (existing?.status === 'suspended' || existing?.status === 'deactivated')
      throw AppError.unauthenticated('This account is not active');

    const role = input.roleKey
      ? await this.prisma.raw.role.findFirst({ where: { organizationId, key: input.roleKey } })
      : null;
    if (input.roleKey && !role)
      throw AppError.unauthenticated(
        `The identity provider assigned role "${input.roleKey}", which does not exist here`,
      );

    const membership = existing?.memberships[0];

    if (existing && membership) {
      // An owner's role is never rewritten by a group claim: losing the last
      // owner to an IdP misconfiguration would lock the tenant out entirely.
      if (role && role.id !== membership.roleId && !membership.isOwner) {
        await this.prisma.raw.membership.update({
          where: { id: membership.id },
          data: { roleId: role.id },
        });
        this.logger.info('SSO updated a role from the provider’s groups', {
          userId: existing.id,
          from: membership.role.key,
          to: role.key,
        });
      }
      await this.prisma.raw.user.update({
        where: { id: existing.id },
        data: { lastLoginAt: new Date(), status: 'active', emailVerifiedAt: new Date() },
      });
      return existing.id;
    }

    if (!input.allowJit)
      throw AppError.unauthenticated(
        'This account has not been provisioned, and just-in-time provisioning is disabled for this connection',
      );
    if (!role)
      throw AppError.unauthenticated(
        'The identity provider assigned no group this connection maps to a role, and it has no default role',
      );

    const userId = existing?.id ?? newId('user');
    await this.prisma.raw.$transaction(async (tx) => {
      if (!existing) {
        await tx.user.create({
          data: {
            id: userId,
            email: input.email,
            firstName: input.firstName,
            lastName: input.lastName,
            // No password is set: this account signs in through the provider,
            // and a null hash is what the password path already refuses.
            status: 'active',
            emailVerifiedAt: new Date(),
            lastLoginAt: new Date(),
          },
        });
      }
      await tx.membership.create({
        data: {
          id: newId('membership'),
          organizationId,
          userId,
          roleId: role.id,
          acceptedAt: new Date(),
        },
      });
    });

    this.logger.info('SSO provisioned a new user', { userId, organizationId, role: role.key });
    return userId;
  }

  // ── Provider calls ─────────────────────────────────────────────────────────

  /**
   * Verify the ID token, refetching the JWKS once if it does not verify.
   *
   * A provider that has just rotated its signing key publishes the new one
   * immediately, but the cached copy is up to fifteen minutes stale. Without
   * the retry every login at that domain fails for the rest of the TTL, which
   * is a tenant-wide outage caused by a routine operation at the provider.
   */
  private async verify(connectionId: string, config: StoredConfig, idToken: string, nonce: string) {
    const expected = { issuer: config.issuer, audience: config.clientId, nonce };

    for (const force of [false, true]) {
      const keys = await this.fetchJwks(connectionId, config.jwksUri, force);
      try {
        return verifyIdToken(idToken, keys, expected);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only a key mismatch is worth refetching for; a wrong issuer, a bad
        // nonce or an expired token will fail identically against fresh keys.
        const keyProblem = /signature does not verify|No key in the provider/.test(message);
        if (force || !keyProblem) {
          this.logger.warn('An ID token was rejected', { connectionId, reason: message });
          // A rejected token is a failed login, not a server fault.
          throw AppError.unauthenticated(message);
        }
        this.logger.info('Refetching the provider JWKS after a key mismatch', { connectionId });
      }
    }

    /* c8 ignore next */
    throw AppError.unauthenticated('The ID token could not be verified');
  }

  private async exchangeCode(
    config: StoredConfig,
    code: string,
    redirectUri: string,
    verifier: string,
  ): Promise<string> {
    const egress = isEgressAllowed(config.tokenEndpoint);
    if (!egress.allowed)
      throw AppError.badRequest(`The token endpoint is unreachable: ${egress.reason}`);

    const response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: this.crypto.decrypt(config.clientSecret),
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw AppError.unauthenticated(
        `The identity provider refused the authorization code (${response.status}${body ? `: ${body.slice(0, 200)}` : ''})`,
      );
    }

    const payload = (await response.json()) as { id_token?: string };
    if (!payload.id_token)
      throw AppError.unauthenticated('The identity provider returned no ID token');
    return payload.id_token;
  }

  /** JWKS, cached: providers rate-limit it, and it changes only on rotation. */
  private async fetchJwks(connectionId: string, jwksUri: string, force = false): Promise<Jwk[]> {
    const key = this.jwksKey(connectionId);
    if (!force) {
      const cached = await this.redis.get<Jwk[]>(key);
      if (cached?.length) return cached;
    }

    const egress = isEgressAllowed(jwksUri);
    if (!egress.allowed) throw AppError.badRequest(`The JWKS URI is unreachable: ${egress.reason}`);

    const response = await fetch(jwksUri, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw AppError.dependency(
        'The identity provider JWKS',
        `${response.status} ${response.statusText}`,
      );

    const payload = (await response.json()) as { keys?: Jwk[] };
    const keys = (payload.keys ?? []).filter((jwk) => jwk.kty === 'RSA' || jwk.kty === 'EC');
    if (!keys.length) throw AppError.badRequest('The JWKS URI published no usable signing keys');

    await this.redis.set(key, keys, JWKS_CACHE_SECONDS);
    return keys;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private jwksKey(connectionId: string): string {
    return `sso:jwks:${connectionId}`;
  }

  private normalizeDomain(domain: string): string {
    const normalized = domain.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized))
      throw AppError.badRequest(`"${domain}" is not an email domain`);
    return normalized;
  }

  private async validateEndpoints(input: SsoConnectionInput): Promise<void> {
    for (const [label, url] of [
      ['issuer', input.issuer],
      ['authorization endpoint', input.authorizationEndpoint],
      ['token endpoint', input.tokenEndpoint],
      ['JWKS URI', input.jwksUri],
    ] as const) {
      const egress = isEgressAllowed(url);
      if (!egress.allowed)
        throw AppError.badRequest(`The ${label} cannot be used: ${egress.reason}`);
    }
  }

  private async validateRoles(input: SsoConnectionInput): Promise<void> {
    const wanted = [
      ...(input.groupRoleMapping ?? []).map((rule) => rule.roleKey),
      ...(input.defaultRoleKey ? [input.defaultRoleKey] : []),
    ];
    if (!wanted.length) return;

    const roles = await this.prisma.db.role.findMany({
      where: { key: { in: wanted } },
      select: { key: true },
    });
    const known = new Set(roles.map((role) => role.key));
    const missing = [...new Set(wanted)].filter((key) => !known.has(key));
    if (missing.length)
      throw AppError.badRequest(`No such role: ${missing.map((key) => `"${key}"`).join(', ')}`);
  }

  private packConfig(input: SsoConnectionInput): StoredConfig {
    const { domain: _domain, clientSecret, ...rest } = input;
    return {
      ...rest,
      clientSecret: clientSecret.startsWith('v1.')
        ? clientSecret
        : this.crypto.encrypt(clientSecret),
    };
  }

  private configOf(connection: { config: Prisma.JsonValue }): StoredConfig {
    return connection.config as unknown as StoredConfig;
  }

  private async load(connectionId: string) {
    const connection = await this.prisma.db.ssoConnection.findFirst({
      where: { id: connectionId },
    });
    if (!connection) throw AppError.notFound('SSO connection', connectionId);
    return connection;
  }

  /** The client secret and the SCIM token hash never leave the service. */
  private redact<T extends { config: Prisma.JsonValue }>(connection: T) {
    const { clientSecret, scimTokenHash, ...config } = (connection.config ??
      {}) as unknown as StoredConfig;
    return {
      ...connection,
      config: { ...config, clientSecretSet: Boolean(clientSecret) },
      scimEnabled: Boolean(scimTokenHash),
    };
  }
}
