import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../../core/context/request-context';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ROLES, type Permission } from '../auth/permissions';

/** Permissions worth a second look in a review, and why. */
const SENSITIVE_PERMISSIONS: Partial<Record<Permission, string>> = {
  'customer:export': 'can extract customer data in bulk',
  'customer:delete': 'can destroy customer records',
  'apikey:manage': 'can mint credentials that outlive their account',
  'role:manage': 'can grant themselves anything',
  'user:manage': 'can create accounts',
  'governance:manage': 'can shorten retention or lift AI limits',
  'billing:manage': 'can change the plan and its limits',
  'webhook:manage': 'can point a copy of every event at an address they choose',
  'integration:manage': 'can send data to an external system',
  'memory:delete': 'can erase what the platform remembers',
};

/** Beyond this, an account that still holds permissions is worth questioning. */
const DORMANT_DAYS = 60;

export interface AccessReviewRow {
  userId: string;
  email: string;
  name: string;
  status: string;
  roleKey: string;
  roleName: string;
  isOwner: boolean;
  lastLoginAt: string | null;
  daysSinceLogin: number | null;
  /** Never signed in, or not for DORMANT_DAYS. */
  dormant: boolean;
  sensitivePermissions: { permission: string; because: string }[];
  activeSessions: number;
  apiKeys: number;
  flags: string[];
}

/**
 * Who can do what, in one place, for the review an auditor asks for.
 *
 * The permission matrix in the docs says what each role *may* do. This says
 * what actual named people can do today, which is the only version that
 * answers "who could have exported that data" — and the two drift apart the
 * moment somebody is given a custom role.
 */
@Injectable()
export class AccessReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  async review(): Promise<{
    generatedAt: string;
    dormantAfterDays: number;
    summary: { members: number; dormant: number; owners: number; withSensitiveAccess: number };
    rows: AccessReviewRow[];
  }> {
    const memberships = await this.prisma.db.membership.findMany({
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            status: true,
            lastLoginAt: true,
            mfaEnabled: true,
          },
        },
        role: { select: { key: true, name: true, permissions: true } },
      },
    });

    const userIds = memberships.map((membership) => membership.userId);
    const [sessions, apiKeys] = await Promise.all([
      this.prisma.db.session.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, revokedAt: null, expiresAt: { gt: new Date() } },
        _count: { _all: true },
      }),
      this.prisma.db.apiKey.groupBy({
        by: ['createdById'],
        where: { createdById: { in: userIds }, revokedAt: null },
        _count: { _all: true },
      }),
    ]);

    const sessionsByUser = new Map(sessions.map((row) => [row.userId, row._count._all]));
    const keysByUser = new Map(apiKeys.map((row) => [row.createdById ?? '', row._count._all]));

    const now = Date.now();
    const rows = memberships.map((membership): AccessReviewRow => {
      const granted = this.effectivePermissions(membership.role.key, membership.role.permissions);
      const daysSinceLogin = membership.user.lastLoginAt
        ? Math.floor((now - membership.user.lastLoginAt.getTime()) / 86_400_000)
        : null;
      // Never having signed in counts as dormant: an invitation accepted and
      // then forgotten is exactly the account an attacker wants.
      const dormant = daysSinceLogin === null || daysSinceLogin >= DORMANT_DAYS;

      const sensitive = granted
        .filter((permission) => permission in SENSITIVE_PERMISSIONS)
        .map((permission) => ({
          permission,
          because: SENSITIVE_PERMISSIONS[permission as Permission]!,
        }));

      const flags: string[] = [];
      if (dormant && sensitive.length) flags.push('dormant account with sensitive access');
      if (!membership.user.mfaEnabled && sensitive.length)
        flags.push('sensitive access without MFA');
      if (membership.isOwner && membership.user.status !== 'active')
        flags.push('owner whose account is not active');
      if ((keysByUser.get(membership.userId) ?? 0) > 0 && dormant)
        flags.push('dormant account with live API keys');

      return {
        userId: membership.userId,
        email: membership.user.email,
        name: `${membership.user.firstName} ${membership.user.lastName}`.trim(),
        status: membership.user.status,
        roleKey: membership.role.key,
        roleName: membership.role.name,
        isOwner: membership.isOwner,
        lastLoginAt: membership.user.lastLoginAt?.toISOString() ?? null,
        daysSinceLogin,
        dormant,
        sensitivePermissions: sensitive,
        activeSessions: sessionsByUser.get(membership.userId) ?? 0,
        apiKeys: keysByUser.get(membership.userId) ?? 0,
        flags,
      };
    });

    // Most concerning first, so the review starts where it matters rather than
    // at whoever happens to sort first alphabetically.
    rows.sort(
      (a, b) =>
        b.flags.length - a.flags.length ||
        b.sensitivePermissions.length - a.sensitivePermissions.length ||
        (b.daysSinceLogin ?? Number.MAX_SAFE_INTEGER) -
          (a.daysSinceLogin ?? Number.MAX_SAFE_INTEGER),
    );

    return {
      generatedAt: new Date().toISOString(),
      dormantAfterDays: DORMANT_DAYS,
      summary: {
        members: rows.length,
        dormant: rows.filter((row) => row.dormant).length,
        owners: rows.filter((row) => row.isOwner).length,
        withSensitiveAccess: rows.filter((row) => row.sensitivePermissions.length).length,
      },
      rows,
    };
  }

  /**
   * Record that a review happened, and what was decided.
   *
   * Written to the audit trail rather than to a table of its own. The audit
   * trail is already append-only, already retained, and already the thing an
   * auditor is given — a parallel store would be a second thing to secure and
   * a second thing to forget to include.
   */
  async recordCompletion(input: {
    decision: 'approved' | 'changes_required';
    note?: string;
    revokedUserIds?: string[];
  }): Promise<{ recordedAt: string; reviewedMembers: number }> {
    const snapshot = await this.review();
    const reviewer = RequestContextStore.principal();

    await this.audit.record({
      action: 'governance.access_review_completed',
      resourceType: 'organization',
      resourceId: RequestContextStore.organizationId(),
      after: {
        decision: input.decision,
        note: input.note,
        reviewedMembers: snapshot.summary.members,
        dormant: snapshot.summary.dormant,
        flagged: snapshot.rows
          .filter((row) => row.flags.length)
          .map((row) => ({
            userId: row.userId,
            flags: row.flags,
          })),
        revokedUserIds: input.revokedUserIds ?? [],
        reviewer: reviewer?.id,
      },
    });

    this.logger.info('Access review recorded', {
      decision: input.decision,
      members: snapshot.summary.members,
    });
    return { recordedAt: new Date().toISOString(), reviewedMembers: snapshot.summary.members };
  }

  /**
   * A custom role stores its own permissions; a system role's live in code, so
   * that adding a permission to a role reaches every tenant at once. Reading
   * only the stored column would under-report every system role's access.
   */
  private effectivePermissions(roleKey: string, stored: string[]): string[] {
    const system = SYSTEM_ROLES[roleKey as keyof typeof SYSTEM_ROLES];
    if (!system) return stored;
    return [...new Set([...system.permissions, ...stored])];
  }
}
