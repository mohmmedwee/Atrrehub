import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { authenticator } from 'otplib';
import type { AppConfig } from '../../config/configuration';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { MailService } from '../../core/mail/mail.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { TenancyService } from '../tenancy/tenancy.service';
import type { AccessTokenClaims } from './guards/auth.guard';
import type { LoginInput, RegisterInput } from './dto/auth.dto';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_BASE_SECONDS = 60;
const RESET_TTL_MINUTES = 30;
const VERIFY_TTL_HOURS = 48;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface AuthResult extends AuthTokens {
  user: { id: string; email: string; firstName: string; lastName: string; mfaEnabled: boolean };
  organization: { id: string; name: string; slug: string };
  role: string;
  permissions: string[];
}

/**
 * Authentication and session lifecycle.
 *
 * Refresh tokens are opaque, stored hashed, and rotated on every use; reusing a
 * rotated token revokes the whole family, which is the standard detection for a
 * stolen token being replayed.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig>,
    private readonly mail: MailService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly tenancy: TenancyService,
    private readonly logger: AppLogger,
  ) {}

  // ── Registration ───────────────────────────────────────────────────────────

  /** Creates the user, their organization, the system roles and an owner membership. */
  async register(input: RegisterInput): Promise<AuthResult> {
    const existing = await this.prisma.raw.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw AppError.conflict('An account with this email address already exists');
    }

    const userId = newId('user');
    const passwordHash = await this.crypto.hashPassword(input.password);

    const { organization, membership, role } = await this.prisma.raw.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          timezone: input.timezone,
          locale: input.locale,
          status: 'active',
        },
      });
      return this.tenancy.provisionOrganization(tx, {
        name: input.organizationName,
        ownerId: userId,
        timezone: input.timezone,
        locale: input.locale,
      });
    });

    // A transient mail failure must not cost the user their account; they can
    // request a fresh verification link at any time.
    await this.sendVerificationEmail(userId, input.email, input.firstName).catch((error) =>
      this.logger.error('Could not send the verification email', error, { userId }),
    );

    RequestContextStore.patch({ organizationId: organization.id });
    await this.events.publish(DomainEvent.OrganizationCreated, { type: 'organization', id: organization.id }, {
      name: organization.name,
      plan: organization.plan,
    });
    await this.audit.record({
      action: 'auth.register',
      resourceType: 'user',
      resourceId: userId,
      organizationId: organization.id,
      actorId: userId,
    });

    return this.issueSession({
      userId,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      mfaEnabled: false,
      organization,
      roleKey: role.key,
      permissions: role.permissions,
      isOwner: membership.isOwner,
      mfaVerified: false,
    });
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await this.prisma.raw.user.findUnique({
      where: { email: input.email },
      include: {
        memberships: {
          include: { organization: true, role: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    // Uniform failure message and timing: never reveal whether the email exists.
    if (!user?.passwordHash) {
      await this.crypto.hashPassword(input.password);
      throw AppError.unauthenticated('Invalid email address or password');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError('rate_limited', 'Too many failed attempts. Try again later.', {
        meta: { retryAfter: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000) },
      });
    }

    const valid = await this.crypto.verifyPassword(input.password, user.passwordHash);
    if (!valid) {
      await this.recordFailedLogin(user.id, user.failedLoginCount);
      throw AppError.unauthenticated('Invalid email address or password');
    }

    if (user.status === 'suspended' || user.status === 'deactivated') {
      throw AppError.unauthenticated('This account is not active');
    }

    const membership = input.organizationId
      ? user.memberships.find((m) => m.organizationId === input.organizationId)
      : user.memberships[0];
    if (!membership) throw AppError.unauthenticated('This account does not belong to any organization');

    let mfaVerified = false;
    if (user.mfaEnabled) {
      if (!input.mfaCode) {
        throw new AppError('unauthenticated', 'A multi-factor code is required', { meta: { mfaRequired: true } });
      }
      mfaVerified = await this.verifyMfaCode(user.id, user.mfaSecret, user.mfaRecoveryCodes, input.mfaCode);
      if (!mfaVerified) {
        await this.recordFailedLogin(user.id, user.failedLoginCount);
        throw AppError.unauthenticated('The multi-factor code is invalid');
      }
    }

    await this.prisma.raw.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    RequestContextStore.patch({ organizationId: membership.organizationId });
    await this.audit.record({
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      organizationId: membership.organizationId,
      actorId: user.id,
    });

    return this.issueSession({
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      mfaEnabled: user.mfaEnabled,
      organization: membership.organization,
      roleKey: membership.role.key,
      permissions: membership.role.permissions,
      isOwner: membership.isOwner,
      mfaVerified,
    });
  }

  /** Exponential lockout: 1m, 2m, 4m … capped, after the threshold is crossed. */
  private async recordFailedLogin(userId: string, current: number): Promise<void> {
    const count = current + 1;
    const shouldLock = count >= MAX_FAILED_LOGINS;
    const backoff = LOCKOUT_BASE_SECONDS * 2 ** Math.min(count - MAX_FAILED_LOGINS, 6);
    await this.prisma.raw.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: count,
        lockedUntil: shouldLock ? new Date(Date.now() + backoff * 1000) : null,
      },
    });
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  private async issueSession(params: {
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
    mfaEnabled: boolean;
    organization: { id: string; name: string; slug: string };
    roleKey: string;
    permissions: string[];
    isOwner: boolean;
    mfaVerified: boolean;
    rotatedFromId?: string;
  }): Promise<AuthResult> {
    const security = this.config.get('security', { infer: true })!;
    const context = RequestContextStore.get();

    const claims: AccessTokenClaims = {
      sub: params.userId,
      org: params.organization.id,
      role: params.roleKey,
      perms: params.permissions,
      owner: params.isOwner,
      mfa: params.mfaVerified,
      typ: 'access',
    };
    const accessToken = await this.jwt.signAsync(claims, { expiresIn: security.accessTtl as never });
    const refreshToken = `rt_${this.crypto.randomToken(48)}`;

    await this.prisma.raw.session.create({
      data: {
        id: newId('session'),
        userId: params.userId,
        organizationId: params.organization.id,
        refreshTokenHash: this.crypto.hashToken(refreshToken),
        userAgent: context?.userAgent ?? null,
        ipAddress: context?.ipAddress ?? null,
        mfaVerified: params.mfaVerified,
        expiresAt: new Date(Date.now() + parseDuration(security.refreshTtl)),
        rotatedFromId: params.rotatedFromId ?? null,
      },
    });

    await this.events
      .publish(
        DomainEvent.SessionCreated,
        { type: 'user', id: params.userId },
        { ip: context?.ipAddress, userAgent: context?.userAgent },
        { organizationId: params.organization.id },
      )
      .catch(() => undefined);

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(parseDuration(security.accessTtl) / 1000),
      tokenType: 'Bearer',
      user: {
        id: params.userId,
        email: params.email,
        firstName: params.firstName,
        lastName: params.lastName,
        mfaEnabled: params.mfaEnabled,
      },
      organization: {
        id: params.organization.id,
        name: params.organization.name,
        slug: params.organization.slug,
      },
      role: params.roleKey,
      permissions: params.permissions,
    };
  }

  /**
   * Rotate a refresh token. Presenting a token that was already rotated means
   * someone replayed a stolen credential, so every session for that user is
   * revoked rather than just the one presented.
   */
  async refresh(refreshToken: string): Promise<AuthResult> {
    const hash = this.crypto.hashToken(refreshToken);
    const session = await this.prisma.raw.session.findUnique({ where: { refreshTokenHash: hash } });

    if (!session) throw AppError.unauthenticated('The refresh token is invalid');

    if (session.revokedAt) {
      this.logger.warn('Reuse of a revoked refresh token detected', { userId: session.userId });
      await this.revokeAllSessions(session.userId, 'refresh_token_reuse');
      throw AppError.unauthenticated('This session has been revoked');
    }
    if (session.expiresAt < new Date()) {
      throw AppError.unauthenticated('This session has expired');
    }

    const user = await this.prisma.raw.user.findUnique({
      where: { id: session.userId },
      include: { memberships: { include: { organization: true, role: true } } },
    });
    const membership = user?.memberships.find((m) => m.organizationId === session.organizationId);
    if (!user || !membership) throw AppError.unauthenticated('This session is no longer valid');

    await this.prisma.raw.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), lastUsedAt: new Date() },
    });

    RequestContextStore.patch({ organizationId: membership.organizationId });
    return this.issueSession({
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      mfaEnabled: user.mfaEnabled,
      organization: membership.organization,
      roleKey: membership.role.key,
      permissions: membership.role.permissions,
      isOwner: membership.isOwner,
      mfaVerified: session.mfaVerified,
      rotatedFromId: session.id,
    });
  }

  async logout(refreshToken: string): Promise<void> {
    const session = await this.prisma.raw.session.findUnique({
      where: { refreshTokenHash: this.crypto.hashToken(refreshToken) },
    });
    if (!session) return;
    await this.prisma.raw.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    await this.audit.record({
      action: 'auth.logout',
      resourceType: 'user',
      resourceId: session.userId,
      organizationId: session.organizationId ?? undefined,
      actorId: session.userId,
    });
  }

  /**
   * Kill every session for a user.
   *
   * Access tokens are stateless, so a watermark in Redis closes the window in
   * which an already-issued one would still verify. It records *when* the
   * revocation happened rather than a flag, so a legitimate login immediately
   * afterwards is not caught by the same sweep. The key expires once no
   * outstanding access token could still be valid.
   */
  async revokeAllSessions(userId: string, reason: string): Promise<void> {
    await this.prisma.raw.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const accessTtlMs = parseDuration(this.config.get('security', { infer: true })!.accessTtl);
    await this.redis.client.set(
      `atr:global:revoked-before:${userId}`,
      String(Math.floor(Date.now() / 1000)),
      'PX',
      Math.max(accessTtlMs, 60_000),
    );
    this.logger.info('Revoked all sessions for a user', { userId, reason });
  }

  async listSessions(userId: string) {
    return this.prisma.raw.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
  }

  // ── Passwords ──────────────────────────────────────────────────────────────

  /** Always reports success — whether the address exists is not disclosed. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.raw.user.findUnique({ where: { email } });
    if (!user) return;

    const token = this.crypto.randomToken(32);
    await this.prisma.raw.verificationToken.create({
      data: {
        id: newId('token'),
        userId: user.id,
        purpose: 'password_reset',
        tokenHash: this.crypto.hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      },
    });

    const url = `${this.config.get('http', { infer: true })!.publicWebUrl}/reset-password?token=${token}`;
    await this.mail.send({
      to: email,
      subject: 'Reset your Atrrehub password',
      html: this.mail.renderLayout({
        title: 'Reset your password',
        body: `<p>Hello ${escapeHtml(user.firstName)},</p><p>We received a request to reset your password. This link expires in ${RESET_TTL_MINUTES} minutes.</p>`,
        ctaLabel: 'Choose a new password',
        ctaUrl: url,
      }),
      text: `Reset your password: ${url}`,
    });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const record = await this.consumeToken(token, 'password_reset');
    const passwordHash = await this.crypto.hashPassword(password);
    await this.prisma.raw.user.update({
      where: { id: record.userId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    });
    // A password change invalidates every existing session.
    await this.revokeAllSessions(record.userId, 'password_reset');
    await this.audit.record({ action: 'auth.password_reset', resourceType: 'user', resourceId: record.userId });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.raw.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await this.crypto.verifyPassword(currentPassword, user.passwordHash))) {
      throw AppError.unauthenticated('The current password is incorrect');
    }
    await this.prisma.raw.user.update({
      where: { id: userId },
      data: { passwordHash: await this.crypto.hashPassword(newPassword) },
    });
    await this.revokeAllSessions(userId, 'password_changed');
    await this.audit.record({ action: 'auth.password_changed', resourceType: 'user', resourceId: userId });
  }

  // ── Email verification ─────────────────────────────────────────────────────

  async sendVerificationEmail(userId: string, email: string, firstName: string): Promise<void> {
    const token = this.crypto.randomToken(32);
    await this.prisma.raw.verificationToken.create({
      data: {
        id: newId('token'),
        userId,
        purpose: 'email_verification',
        tokenHash: this.crypto.hashToken(token),
        expiresAt: new Date(Date.now() + VERIFY_TTL_HOURS * 3600_000),
      },
    });
    const url = `${this.config.get('http', { infer: true })!.publicWebUrl}/verify-email?token=${token}`;
    await this.mail.send({
      to: email,
      subject: 'Verify your Atrrehub email address',
      html: this.mail.renderLayout({
        title: 'Confirm your email address',
        body: `<p>Welcome ${escapeHtml(firstName)},</p><p>Confirm this address to finish setting up your Atrrehub account.</p>`,
        ctaLabel: 'Verify email',
        ctaUrl: url,
      }),
      text: `Verify your email: ${url}`,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.consumeToken(token, 'email_verification');
    await this.prisma.raw.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: new Date(), status: 'active' },
    });
  }

  private async consumeToken(token: string, purpose: string) {
    const record = await this.prisma.raw.verificationToken.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
    });
    if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt < new Date()) {
      throw AppError.badRequest('This link is invalid or has expired');
    }
    await this.prisma.raw.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    return record;
  }

  // ── Multi-factor authentication ────────────────────────────────────────────

  /** Returns the provisioning URI for the authenticator app; not yet enabled. */
  async beginMfaSetup(userId: string, email: string): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = authenticator.generateSecret();
    await this.prisma.raw.user.update({
      where: { id: userId },
      data: { mfaSecret: this.crypto.encrypt(secret) },
    });
    return { secret, otpauthUrl: authenticator.keyuri(email, 'Atrrehub', secret) };
  }

  async confirmMfaSetup(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.raw.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaSecret) throw AppError.badRequest('Start multi-factor setup first');
    if (!authenticator.verify({ token: code, secret: this.crypto.decrypt(user.mfaSecret) })) {
      throw AppError.badRequest('The code is incorrect');
    }

    const recoveryCodes = Array.from({ length: 10 }, () => this.crypto.randomToken(6));
    await this.prisma.raw.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: true,
        mfaRecoveryCodes: recoveryCodes.map((c) => this.crypto.hashToken(c)),
      },
    });
    await this.audit.record({ action: 'auth.mfa_enabled', resourceType: 'user', resourceId: userId });
    return { recoveryCodes };
  }

  async disableMfa(userId: string, code: string): Promise<void> {
    const user = await this.prisma.raw.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await this.verifyMfaCode(userId, user.mfaSecret, user.mfaRecoveryCodes, code))) {
      throw AppError.badRequest('The code is incorrect');
    }
    await this.prisma.raw.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: [] },
    });
    await this.audit.record({ action: 'auth.mfa_disabled', resourceType: 'user', resourceId: userId });
  }

  /** Accepts a TOTP code or a single-use recovery code, consuming the latter. */
  private async verifyMfaCode(
    userId: string,
    encryptedSecret: string | null,
    recoveryHashes: string[],
    code: string,
  ): Promise<boolean> {
    if (encryptedSecret && authenticator.verify({ token: code, secret: this.crypto.decrypt(encryptedSecret) })) {
      return true;
    }
    const hash = this.crypto.hashToken(code);
    if (recoveryHashes.includes(hash)) {
      await this.prisma.raw.user.update({
        where: { id: userId },
        data: { mfaRecoveryCodes: recoveryHashes.filter((h) => h !== hash) },
      });
      return true;
    }
    return false;
  }
}

/** Parses `15m`, `30d`, `12h`, `45s` into milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return amount * scale[unit as keyof typeof scale];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
