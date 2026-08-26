import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * SCIM 2.0 (RFC 7643 / 7644), User and Group resources.
 *
 * The identity provider is the authority here: it creates, updates and
 * deactivates people, and the platform's job is to reflect that faithfully and
 * to answer in the shapes the specification requires — a provider that gets a
 * plain 404 body where it expected a SCIM error will silently stop syncing.
 */

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

export interface ScimUser {
  schemas: string[];
  id: string;
  userName: string;
  name: { givenName: string; familyName: string; formatted: string };
  emails: { value: string; primary: boolean; type: string }[];
  active: boolean;
  displayName: string;
  meta: { resourceType: string; created: string; lastModified: string; location: string };
  roles?: { value: string; display: string }[];
}

/** SCIM pages are 1-indexed, and a provider will page a large directory. */
const DEFAULT_COUNT = 100;
const MAX_COUNT = 500;

@Injectable()
export class ScimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  // ── Users ──────────────────────────────────────────────────────────────────

  async listUsers(params: { filter?: string; startIndex?: number; count?: number }) {
    const organizationId = RequestContextStore.organizationId()!;
    const startIndex = Math.max(params.startIndex ?? 1, 1);
    const count = Math.min(params.count ?? DEFAULT_COUNT, MAX_COUNT);
    const email = this.parseUserNameFilter(params.filter);

    const where = {
      organizationId,
      ...(email ? { user: { email } } : {}),
    };

    const [total, memberships] = await Promise.all([
      this.prisma.raw.membership.count({ where }),
      this.prisma.raw.membership.findMany({
        where,
        include: { user: true, role: true },
        orderBy: { createdAt: 'asc' },
        skip: startIndex - 1,
        take: count,
      }),
    ]);

    return {
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: memberships.length,
      Resources: memberships.map((membership) => this.toScimUser(membership)),
    };
  }

  async getUser(userId: string): Promise<ScimUser> {
    return this.toScimUser(await this.loadMembership(userId));
  }

  /**
   * Provision a user.
   *
   * A person already known to the platform — invited by an administrator, or a
   * member of another tenant — is given a membership rather than rejected: the
   * provider is asserting they belong here, and refusing would leave the
   * directory permanently out of step with no way to reconcile it.
   */
  async createUser(payload: Record<string, unknown>, defaultRoleKey?: string): Promise<ScimUser> {
    const organizationId = RequestContextStore.organizationId()!;
    const email = this.emailOf(payload);
    const name = (payload.name ?? {}) as Record<string, string>;
    const roleKey = this.roleFrom(payload) ?? defaultRoleKey;

    const role = await this.prisma.raw.role.findFirst({
      where: { organizationId, key: roleKey ?? 'agent' },
    });
    if (!role)
      throw this.scimError(
        400,
        'invalidValue',
        `No role "${roleKey ?? 'agent'}" exists in this organization`,
      );

    const existing = await this.prisma.raw.user.findUnique({ where: { email } });
    const already = existing
      ? await this.prisma.raw.membership.findFirst({
          where: { organizationId, userId: existing.id },
        })
      : null;
    if (already) throw this.scimError(409, 'uniqueness', 'This user already exists');

    const userId = existing?.id ?? newId('user');
    await this.prisma.raw.$transaction(async (tx) => {
      if (!existing) {
        await tx.user.create({
          data: {
            id: userId,
            email,
            firstName: name.givenName || email.split('@')[0],
            lastName: name.familyName || '',
            status: payload.active === false ? 'deactivated' : 'active',
            emailVerifiedAt: new Date(),
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

    await this.audit.record({
      action: 'scim.user_created',
      resourceType: 'user',
      resourceId: userId,
      after: { email, role: role.key },
    });
    this.logger.info('SCIM provisioned a user', { userId, organizationId, role: role.key });

    return this.getUser(userId);
  }

  /** PUT: the provider is replacing the resource, so absent fields are absent. */
  async replaceUser(userId: string, payload: Record<string, unknown>): Promise<ScimUser> {
    const membership = await this.loadMembership(userId);
    const name = (payload.name ?? {}) as Record<string, string>;

    await this.prisma.raw.user.update({
      where: { id: userId },
      data: {
        firstName: name.givenName || membership.user.firstName,
        lastName: name.familyName ?? membership.user.lastName,
        ...(payload.active === undefined
          ? {}
          : { status: payload.active ? ('active' as const) : ('deactivated' as const) }),
      },
    });

    const roleKey = this.roleFrom(payload);
    if (roleKey) await this.applyRole(membership.id, membership.organizationId, roleKey);

    return this.getUser(userId);
  }

  /**
   * PATCH. Only the operations providers actually send are honoured — the
   * common one by far is `replace` on `active` to deactivate a leaver.
   */
  async patchUser(userId: string, payload: Record<string, unknown>): Promise<ScimUser> {
    const membership = await this.loadMembership(userId);
    const operations = (payload.Operations ?? payload.operations ?? []) as {
      op?: string;
      path?: string;
      value?: unknown;
    }[];
    if (!Array.isArray(operations) || !operations.length)
      throw this.scimError(400, 'invalidSyntax', 'A PATCH must carry at least one operation');

    const data: Record<string, unknown> = {};
    let roleKey: string | undefined;

    for (const operation of operations) {
      const op = (operation.op ?? '').toLowerCase();
      if (op === 'remove' && operation.path === 'active') {
        data.status = 'deactivated';
        continue;
      }
      if (op !== 'replace' && op !== 'add') continue;

      // A pathless operation carries an object of attributes to merge.
      const entries: [string, unknown][] = operation.path
        ? [[operation.path, operation.value]]
        : Object.entries((operation.value ?? {}) as Record<string, unknown>);

      for (const [path, value] of entries) {
        switch (path.toLowerCase()) {
          case 'active':
            data.status = this.truthy(value) ? 'active' : 'deactivated';
            break;
          case 'name.givenname':
            data.firstName = String(value);
            break;
          case 'name.familyname':
            data.lastName = String(value);
            break;
          case 'name':
            if (value && typeof value === 'object') {
              const name = value as Record<string, string>;
              if (name.givenName) data.firstName = name.givenName;
              if (name.familyName) data.lastName = name.familyName;
            }
            break;
          case 'roles':
            roleKey = this.roleFrom({ roles: value });
            break;
          default:
            break;
        }
      }
    }

    if (Object.keys(data).length)
      await this.prisma.raw.user.update({ where: { id: userId }, data });
    if (roleKey) await this.applyRole(membership.id, membership.organizationId, roleKey);

    if (data.status === 'deactivated') {
      await this.audit.record({
        action: 'scim.user_deactivated',
        resourceType: 'user',
        resourceId: userId,
      });
    }

    return this.getUser(userId);
  }

  /**
   * DELETE. The membership is removed and the account deactivated; the user
   * row itself is kept, because their name is attached to conversations,
   * tickets and audit entries that must stay readable after they leave.
   */
  async deleteUser(userId: string): Promise<void> {
    const membership = await this.loadMembership(userId);

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.membership.delete({ where: { id: membership.id } });
      const remaining = await tx.membership.count({ where: { userId } });
      if (!remaining)
        await tx.user.update({ where: { id: userId }, data: { status: 'deactivated' } });
    });

    await this.audit.record({
      action: 'scim.user_deprovisioned',
      resourceType: 'user',
      resourceId: userId,
    });
  }

  // ── Groups ─────────────────────────────────────────────────────────────────

  /**
   * Groups are the organization's roles, read-only.
   *
   * A provider can see them and map to them, but cannot create one: a group
   * created over SCIM would carry no permissions, and a role is a security
   * boundary that belongs to an administrator here, not to a directory admin.
   */
  async listGroups(params: { startIndex?: number; count?: number } = {}) {
    const organizationId = RequestContextStore.organizationId()!;
    const startIndex = Math.max(params.startIndex ?? 1, 1);
    const count = Math.min(params.count ?? DEFAULT_COUNT, MAX_COUNT);

    const [total, roles] = await Promise.all([
      this.prisma.raw.role.count({ where: { organizationId } }),
      this.prisma.raw.role.findMany({
        where: { organizationId },
        include: { memberships: { include: { user: { select: { id: true, email: true } } } } },
        orderBy: { key: 'asc' },
        skip: startIndex - 1,
        take: count,
      }),
    ]);

    return {
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: roles.length,
      Resources: roles.map((role) => ({
        schemas: [GROUP_SCHEMA],
        id: role.key,
        displayName: role.name,
        members: role.memberships.map((membership) => ({
          value: membership.user.id,
          display: membership.user.email,
        })),
        meta: {
          resourceType: 'Group',
          created: role.createdAt.toISOString(),
          lastModified: role.updatedAt.toISOString(),
          location: `/scim/v2/Groups/${role.key}`,
        },
      })),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async applyRole(membershipId: string, organizationId: string, roleKey: string) {
    const role = await this.prisma.raw.role.findFirst({
      where: { organizationId, key: roleKey },
    });
    if (!role) throw this.scimError(400, 'invalidValue', `No role "${roleKey}" exists here`);

    const membership = await this.prisma.raw.membership.findUnique({ where: { id: membershipId } });
    // An owner's role is never rewritten from the directory: losing the last
    // owner to a misconfigured mapping would lock the tenant out entirely.
    if (membership?.isOwner) return;

    await this.prisma.raw.membership.update({
      where: { id: membershipId },
      data: { roleId: role.id },
    });
  }

  private async loadMembership(userId: string) {
    const organizationId = RequestContextStore.organizationId()!;
    const membership = await this.prisma.raw.membership.findFirst({
      where: { organizationId, userId },
      include: { user: true, role: true },
    });
    if (!membership) throw this.scimError(404, 'notFound', `No user with id "${userId}"`);
    return membership;
  }

  private toScimUser(membership: {
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      status: string;
      createdAt: Date;
      updatedAt: Date;
    };
    role: { key: string; name: string };
  }): ScimUser {
    const { user, role } = membership;
    const formatted = [user.firstName, user.lastName].filter(Boolean).join(' ');

    return {
      schemas: [USER_SCHEMA],
      id: user.id,
      userName: user.email,
      name: { givenName: user.firstName, familyName: user.lastName, formatted },
      emails: [{ value: user.email, primary: true, type: 'work' }],
      active: user.status === 'active' || user.status === 'invited',
      displayName: formatted || user.email,
      roles: [{ value: role.key, display: role.name }],
      meta: {
        resourceType: 'User',
        created: user.createdAt.toISOString(),
        lastModified: user.updatedAt.toISOString(),
        location: `/scim/v2/Users/${user.id}`,
      },
    };
  }

  private emailOf(payload: Record<string, unknown>): string {
    const userName = typeof payload.userName === 'string' ? payload.userName : '';
    const emails = Array.isArray(payload.emails)
      ? (payload.emails as { value?: string; primary?: boolean }[])
      : [];
    const primary = emails.find((entry) => entry.primary) ?? emails[0];
    const email = (userName.includes('@') ? userName : (primary?.value ?? '')).trim().toLowerCase();

    if (!email.includes('@'))
      throw this.scimError(400, 'invalidValue', 'userName must be an email address');
    return email;
  }

  private roleFrom(payload: Record<string, unknown>): string | undefined {
    const roles = payload.roles;
    if (typeof roles === 'string') return roles;
    if (!Array.isArray(roles) || !roles.length) return undefined;
    const first = roles[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') {
      const value = (first as { value?: unknown }).value;
      if (typeof value === 'string') return value;
    }
    return undefined;
  }

  /** `userName eq "ada@example.com"` — the one filter providers rely on. */
  private parseUserNameFilter(filter?: string): string | undefined {
    if (!filter) return undefined;
    const match = filter.match(/^\s*userName\s+eq\s+"([^"]+)"\s*$/i);
    if (!match)
      throw this.scimError(
        400,
        'invalidFilter',
        'Only `userName eq "..."` is supported as a filter',
      );
    return match[1].toLowerCase();
  }

  private truthy(value: unknown): boolean {
    return value === true || value === 'true' || value === 'True';
  }

  /** SCIM errors have their own body shape; a plain problem document breaks providers. */
  private scimError(status: number, scimType: string, detail: string): AppError {
    return new AppError(
      status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'validation_failed',
      detail,
      { meta: { scim: { schemas: [ERROR_SCHEMA], scimType, detail, status: String(status) } } },
    );
  }
}
