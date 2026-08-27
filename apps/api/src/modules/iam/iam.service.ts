import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { MailService } from '../../core/mail/mail.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { PERMISSIONS, hasAllPermissions, type Permission } from '../auth/permissions';
import { cursorArgs, paginate, type CursorParams } from '../../common/pagination';

const INVITE_TTL_DAYS = 14;

/**
 * User, role and API-key administration within an organization.
 */
@Injectable()
export class IamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly auth: AuthService,
  ) {}

  // ── Users ──────────────────────────────────────────────────────────────────

  async listUsers(
    organizationId: string,
    params: CursorParams & { search?: string; roleKey?: string; status?: string },
  ) {
    const where: Prisma.MembershipWhereInput = {
      organizationId,
      ...(params.roleKey ? { role: { key: params.roleKey } } : {}),
      ...(params.status ? { user: { status: params.status as never } } : {}),
      ...(params.search
        ? {
            user: {
              OR: [
                { email: { contains: params.search, mode: 'insensitive' } },
                { firstName: { contains: params.search, mode: 'insensitive' } },
                { lastName: { contains: params.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const rows = await this.prisma.db.membership.findMany({
      where,
      include: {
        user: { select: USER_FIELDS },
        role: { select: { id: true, key: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...cursorArgs(params),
    });

    const page = paginate(rows, params.limit);
    return {
      ...page,
      data: page.data.map((m) => ({
        membershipId: m.id,
        ...m.user,
        role: m.role,
        isOwner: m.isOwner,
        workspaceIds: m.workspaceIds,
        acceptedAt: m.acceptedAt,
        invitedAt: m.invitedAt,
      })),
    };
  }

  async getUser(organizationId: string, userId: string) {
    const membership = await this.prisma.db.membership.findFirst({
      where: { organizationId, userId },
      include: {
        user: {
          select: {
            ...USER_FIELDS,
            teamMemberships: { include: { team: { select: { id: true, name: true } } } },
          },
        },
        role: true,
      },
    });
    if (!membership) throw AppError.notFound('User', userId);
    return {
      membershipId: membership.id,
      ...membership.user,
      role: { id: membership.role.id, key: membership.role.key, name: membership.role.name },
      permissions: membership.role.permissions,
      isOwner: membership.isOwner,
      workspaceIds: membership.workspaceIds,
    };
  }

  /**
   * Invite someone to the organization. An existing platform user is added as a
   * new membership; a new user is created in `invited` state and receives a
   * link that sets their password.
   */
  async inviteUser(input: {
    email: string;
    firstName: string;
    lastName: string;
    roleKey: string;
    workspaceIds?: string[];
    skills?: string[];
    languages?: string[];
  }) {
    const organizationId = RequestContextStore.organizationId()!;
    const role = await this.prisma.db.role.findFirst({
      where: { organizationId, key: input.roleKey },
    });
    if (!role) throw AppError.badRequest(`Unknown role "${input.roleKey}"`);

    // An administrator must not be able to grant more than they hold.
    const inviter = RequestContextStore.principal();
    if (inviter && !hasAllPermissions(inviter.permissions, role.permissions)) {
      throw AppError.permissionDenied('You cannot grant permissions you do not hold');
    }

    const existing = await this.prisma.raw.user.findUnique({ where: { email: input.email } });
    if (existing) {
      const already = await this.prisma.db.membership.findFirst({
        where: { organizationId, userId: existing.id },
      });
      if (already) throw AppError.conflict('This person is already a member of the organization');
    }

    const userId = existing?.id ?? newId('user');
    const inviteToken = this.crypto.randomToken(32);

    await this.prisma.raw.$transaction(async (tx) => {
      if (!existing) {
        await tx.user.create({
          data: {
            id: userId,
            email: input.email,
            firstName: input.firstName,
            lastName: input.lastName,
            status: 'invited',
            skills: input.skills ?? [],
            languages: input.languages ?? [],
          },
        });
      }
      await tx.membership.create({
        data: {
          id: newId('membership'),
          organizationId,
          userId,
          roleId: role.id,
          workspaceIds: input.workspaceIds ?? [],
          invitedById: inviter?.id ?? null,
          invitedAt: new Date(),
          ...(existing ? { acceptedAt: new Date() } : {}),
        },
      });
      await tx.verificationToken.create({
        data: {
          id: newId('token'),
          userId,
          purpose: 'invitation',
          tokenHash: this.crypto.hashToken(inviteToken),
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
          metadata: { organizationId },
        },
      });
    });

    const organization = await this.prisma.raw.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    await this.mail
      .send({
        to: input.email,
        subject: `You have been invited to ${organization.name} on Atrrehub`,
        html: this.mail.renderLayout({
          title: `Join ${escapeHtml(organization.name)}`,
          body: `<p>Hello ${escapeHtml(input.firstName)},</p><p>You have been invited to join <strong>${escapeHtml(organization.name)}</strong> as ${escapeHtml(role.name)}.</p>`,
          ctaLabel: existing ? 'Open Atrrehub' : 'Accept the invitation',
          ctaUrl: existing ? '/workspace' : `/accept-invite?token=${inviteToken}`,
          brandColor: organization.primaryColor ?? undefined,
        }),
        text: existing
          ? 'You have been added to a new organization on Atrrehub.'
          : `Accept your invitation: /accept-invite?token=${inviteToken}`,
      })
      .catch(() => undefined);

    await this.events.publish(
      DomainEvent.UserInvited,
      { type: 'user', id: userId },
      {
        email: input.email,
        roleId: role.id,
      },
    );
    await this.audit.record({
      action: 'user.invited',
      resourceType: 'user',
      resourceId: userId,
      after: { email: input.email, role: role.key },
    });

    return { userId, email: input.email, role: role.key, status: existing ? 'active' : 'invited' };
  }

  /** Completes an invitation: sets the password and activates the account. */
  async acceptInvite(
    token: string,
    input: { password: string; firstName: string; lastName: string },
  ) {
    const record = await this.prisma.raw.verificationToken.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
    });
    if (
      !record ||
      record.purpose !== 'invitation' ||
      record.usedAt ||
      record.expiresAt < new Date()
    ) {
      throw AppError.badRequest('This invitation is invalid or has expired');
    }

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await this.crypto.hashPassword(input.password),
          firstName: input.firstName,
          lastName: input.lastName,
          status: 'active',
          emailVerifiedAt: new Date(),
        },
      });
      await tx.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    });

    const organizationId = (record.metadata as { organizationId?: string })?.organizationId;
    await this.events
      .publish(
        DomainEvent.UserActivated,
        { type: 'user', id: record.userId },
        { userId: record.userId },
        { organizationId },
      )
      .catch(() => undefined);

    const user = await this.prisma.raw.user.findUniqueOrThrow({ where: { id: record.userId } });
    return this.auth.login({ email: user.email, password: input.password });
  }

  async updateUser(
    organizationId: string,
    userId: string,
    patch: {
      firstName?: string;
      lastName?: string;
      roleKey?: string;
      workspaceIds?: string[];
      skills?: string[];
      languages?: string[];
      maxConcurrentChats?: number;
      status?: string;
      timezone?: string;
      locale?: string;
    },
  ) {
    const membership = await this.prisma.db.membership.findFirst({
      where: { organizationId, userId },
      include: { role: true, user: true },
    });
    if (!membership) throw AppError.notFound('User', userId);

    const actor = RequestContextStore.principal();
    if (membership.isOwner && actor?.id !== userId && !actor?.isOwner) {
      throw AppError.permissionDenied('Only an owner can modify the owner account');
    }

    const { roleKey, workspaceIds, status, ...userPatch } = patch;

    if (roleKey && roleKey !== membership.role.key) {
      const role = await this.prisma.db.role.findFirst({ where: { organizationId, key: roleKey } });
      if (!role) throw AppError.badRequest(`Unknown role "${roleKey}"`);
      if (actor && !hasAllPermissions(actor.permissions, role.permissions)) {
        throw AppError.permissionDenied('You cannot grant permissions you do not hold');
      }
      await this.prisma.db.membership.update({
        where: { id: membership.id },
        data: { roleId: role.id },
      });
      await this.events.publish(
        DomainEvent.RoleChanged,
        { type: 'user', id: userId },
        {
          userId,
          from: membership.role.key,
          to: roleKey,
        },
      );
      await this.audit.record({
        action: 'user.role_changed',
        resourceType: 'user',
        resourceId: userId,
        before: { role: membership.role.key },
        after: { role: roleKey },
      });
      // The old access token still carries the old permission set.
      await this.auth.revokeAllSessions(userId, 'role_changed');
    }

    if (workspaceIds) {
      await this.prisma.db.membership.update({
        where: { id: membership.id },
        data: { workspaceIds },
      });
    }

    if (Object.keys(userPatch).length || status) {
      const before = membership.user;
      const after = await this.prisma.raw.user.update({
        where: { id: userId },
        data: { ...userPatch, ...(status ? { status: status as never } : {}) },
        select: USER_FIELDS,
      });
      await this.audit.recordDiff('user.updated', 'user', userId, before as never, after as never);

      if (status === 'suspended' || status === 'deactivated') {
        await this.auth.revokeAllSessions(userId, `status_${status}`);
        await this.events.publish(
          DomainEvent.UserDeactivated,
          { type: 'user', id: userId },
          { userId },
        );
      }
    }

    return this.getUser(organizationId, userId);
  }

  /** Removes the membership. The platform user survives — they may belong elsewhere. */
  async removeUser(organizationId: string, userId: string) {
    const membership = await this.prisma.db.membership.findFirst({
      where: { organizationId, userId },
    });
    if (!membership) throw AppError.notFound('User', userId);
    if (membership.isOwner) throw AppError.conflict('The organization owner cannot be removed');

    await this.prisma.db.membership.delete({ where: { id: membership.id } });
    await this.auth.revokeAllSessions(userId, 'membership_removed');
    await this.audit.record({
      action: 'user.removed',
      resourceType: 'user',
      resourceId: userId,
      before: membership,
    });
  }

  /** Agent presence, used by routing to pick an available assignee. */
  async setPresence(userId: string, presence: string, note?: string) {
    const updated = await this.prisma.raw.user.update({
      where: { id: userId },
      data: { presence: presence as never, presenceNote: note ?? null },
      select: { id: true, presence: true, presenceNote: true },
    });

    // The User row holds only the *current* state, which cannot answer "were
    // they available at 10:15?" — the question adherence is. Workforce
    // management keeps the history, and hears about it through an event so
    // identity does not have to know workforce management exists.
    await this.events
      .publish(
        DomainEvent.AgentPresenceChanged,
        { type: 'user', id: userId },
        { userId, presence, note },
      )
      .catch(() => undefined);

    return updated;
  }

  // ── Roles ──────────────────────────────────────────────────────────────────

  async listRoles(organizationId: string) {
    return this.prisma.db.role.findMany({
      where: { organizationId },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { memberships: true } } },
    });
  }

  async createRole(input: {
    key: string;
    name: string;
    description?: string;
    permissions: string[];
  }) {
    this.assertKnownPermissions(input.permissions);
    const actor = RequestContextStore.principal();
    if (actor && !hasAllPermissions(actor.permissions, input.permissions)) {
      throw AppError.permissionDenied('You cannot grant permissions you do not hold');
    }
    const role = await this.prisma.db.role.create({
      data: {
        id: newId('role'),
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        permissions: input.permissions,
        isSystem: false,
      } as never,
    });
    await this.audit.record({
      action: 'role.created',
      resourceType: 'role',
      resourceId: role.id,
      after: role,
    });
    return role;
  }

  async updateRole(
    organizationId: string,
    roleId: string,
    patch: { name?: string; description?: string; permissions?: string[] },
  ) {
    const role = await this.prisma.db.role.findFirst({ where: { organizationId, id: roleId } });
    if (!role) throw AppError.notFound('Role', roleId);
    if (role.isSystem && patch.permissions) {
      throw AppError.conflict('System role permissions cannot be edited — clone the role instead');
    }
    if (patch.permissions) {
      this.assertKnownPermissions(patch.permissions);
      const actor = RequestContextStore.principal();
      if (actor && !hasAllPermissions(actor.permissions, patch.permissions)) {
        throw AppError.permissionDenied('You cannot grant permissions you do not hold');
      }
    }

    const updated = await this.prisma.db.role.update({ where: { id: roleId }, data: patch });
    await this.audit.recordDiff('role.updated', 'role', roleId, role as never, updated as never);

    // Everyone holding this role needs a token reflecting the new permissions.
    if (patch.permissions) {
      const members = await this.prisma.db.membership.findMany({
        where: { roleId },
        select: { userId: true },
      });
      await Promise.all(
        members.map((m) => this.auth.revokeAllSessions(m.userId, 'role_permissions_changed')),
      );
    }
    return updated;
  }

  async deleteRole(organizationId: string, roleId: string) {
    const role = await this.prisma.db.role.findFirst({
      where: { organizationId, id: roleId },
      include: { _count: { select: { memberships: true } } },
    });
    if (!role) throw AppError.notFound('Role', roleId);
    if (role.isSystem) throw AppError.conflict('System roles cannot be deleted');
    if (role._count.memberships > 0) {
      throw AppError.conflict(`${role._count.memberships} user(s) still hold this role`);
    }
    await this.prisma.db.role.delete({ where: { id: roleId } });
    await this.audit.record({
      action: 'role.deleted',
      resourceType: 'role',
      resourceId: roleId,
      before: role,
    });
  }

  private assertKnownPermissions(permissions: string[]): void {
    const catalog = new Set<string>(PERMISSIONS);
    const unknown = permissions.filter((p) => !catalog.has(p));
    if (unknown.length) {
      throw AppError.badRequest(`Unknown permissions: ${unknown.join(', ')}`);
    }
  }

  // ── API keys ───────────────────────────────────────────────────────────────

  /**
   * The plaintext key is returned exactly once. Only its hash is stored, and
   * its permission set can never exceed the creator's own at creation time.
   */
  async createApiKey(input: { name: string; permissions: Permission[]; expiresInDays?: number }) {
    this.assertKnownPermissions(input.permissions);
    const actor = RequestContextStore.principal();
    if (actor && !hasAllPermissions(actor.permissions, input.permissions)) {
      throw AppError.permissionDenied('An API key cannot exceed your own permissions');
    }

    const secret = this.crypto.randomToken(32);
    const key = `ak_${secret}`;
    const record = await this.prisma.db.apiKey.create({
      data: {
        id: newId('apiKey'),
        name: input.name,
        prefix: key.slice(0, 11),
        keyHash: this.crypto.hashToken(key),
        permissions: input.permissions,
        createdById: actor?.id ?? null,
        expiresAt: input.expiresInDays
          ? new Date(Date.now() + input.expiresInDays * 86_400_000)
          : null,
      } as never,
    });

    await this.events.publish(
      DomainEvent.ApiKeyCreated,
      { type: 'api_key', id: record.id },
      { apiKeyId: record.id },
    );
    await this.audit.record({
      action: 'apikey.created',
      resourceType: 'api_key',
      resourceId: record.id,
      after: { name: input.name, permissions: input.permissions },
    });

    return { ...record, key, keyHash: undefined };
  }

  async listApiKeys(organizationId: string) {
    return this.prisma.db.apiKey.findMany({
      where: { organizationId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        permissions: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  async revokeApiKey(organizationId: string, apiKeyId: string) {
    const key = await this.prisma.db.apiKey.findFirst({ where: { organizationId, id: apiKeyId } });
    if (!key) throw AppError.notFound('API key', apiKeyId);
    await this.prisma.db.apiKey.update({
      where: { id: apiKeyId },
      data: { revokedAt: new Date() },
    });
    await this.events.publish(
      DomainEvent.ApiKeyRevoked,
      { type: 'api_key', id: apiKeyId },
      { apiKeyId },
    );
    await this.audit.record({
      action: 'apikey.revoked',
      resourceType: 'api_key',
      resourceId: apiKeyId,
    });
  }
}

const USER_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  status: true,
  presence: true,
  presenceNote: true,
  locale: true,
  timezone: true,
  skills: true,
  languages: true,
  maxConcurrentChats: true,
  mfaEnabled: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
