import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ROLES, type RoleKey } from '../auth/permissions';

export interface ProvisionInput {
  name: string;
  ownerId: string;
  timezone?: string;
  locale?: string;
  slug?: string;
}

/**
 * Organization and workspace lifecycle — the root of the tenancy chain
 * `User → Organization → Workspace → Resource`.
 */
@Injectable()
export class TenancyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Everything a new tenant needs to be immediately usable: the organization,
   * its eight system roles, an owner membership, a default workspace, business
   * hours, a default SLA policy, a general queue and a starter knowledge base.
   *
   * Runs inside the caller's transaction so a partially provisioned tenant can
   * never exist.
   */
  async provisionOrganization(tx: Prisma.TransactionClient, input: ProvisionInput) {
    const organizationId = newId('organization');
    const slug = await this.uniqueSlug(tx, input.slug ?? input.name);

    const organization = await tx.organization.create({
      data: {
        id: organizationId,
        name: input.name,
        slug,
        timezone: input.timezone ?? 'UTC',
        locale: input.locale ?? 'en',
        defaultLanguage: input.locale ?? 'en',
        plan: 'starter',
      },
    });

    // System roles are seeded per tenant so an administrator can clone and
    // adjust them without affecting anyone else.
    const roles = await Promise.all(
      (Object.keys(SYSTEM_ROLES) as RoleKey[]).map((key) =>
        tx.role.create({
          data: {
            id: newId('role'),
            organizationId,
            key,
            name: SYSTEM_ROLES[key].name,
            description: SYSTEM_ROLES[key].description,
            permissions: SYSTEM_ROLES[key].permissions,
            isSystem: true,
          },
        }),
      ),
    );
    const ownerRole = roles.find((r) => r.key === 'owner')!;

    const membership = await tx.membership.create({
      data: {
        id: newId('membership'),
        organizationId,
        userId: input.ownerId,
        roleId: ownerRole.id,
        isOwner: true,
        acceptedAt: new Date(),
      },
    });

    const workspace = await tx.workspace.create({
      data: {
        id: newId('workspace'),
        organizationId,
        name: 'Default',
        slug: 'default',
        environment: 'production',
        isDefault: true,
      },
    });

    const businessHours = await tx.businessHours.create({
      data: {
        id: newId('businessHours'),
        organizationId,
        name: 'Standard business hours',
        timezone: input.timezone ?? 'UTC',
        // Monday–Friday, 09:00–17:00.
        rules: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
        isDefault: true,
      },
    });

    const slaPolicy = await tx.slaPolicy.create({
      data: {
        id: newId('slaPolicy'),
        organizationId,
        name: 'Default SLA',
        description: 'Applies to any conversation or ticket without a more specific policy',
        businessHoursId: businessHours.id,
        isDefault: true,
      },
    });

    // Response and resolution targets tighten as priority rises.
    const targets: Array<[string, string, number]> = [
      ['first_response', 'low', 480],
      ['first_response', 'normal', 240],
      ['first_response', 'high', 60],
      ['first_response', 'urgent', 30],
      ['first_response', 'critical', 15],
      ['resolution', 'low', 4320],
      ['resolution', 'normal', 2880],
      ['resolution', 'high', 480],
      ['resolution', 'urgent', 240],
      ['resolution', 'critical', 60],
    ];
    await tx.slaTarget.createMany({
      data: targets.map(([type, priority, minutes]) => ({
        id: newId('slaTarget'),
        organizationId,
        policyId: slaPolicy.id,
        type: type as never,
        priority: priority as never,
        durationMinutes: minutes,
        warningPercent: 75,
      })),
    });

    const queue = await tx.queue.create({
      data: {
        id: newId('queue'),
        organizationId,
        workspaceId: workspace.id,
        name: 'General',
        key: 'general',
        description: 'Default queue for unrouted conversations',
        strategy: 'round_robin',
        slaPolicyId: slaPolicy.id,
        businessHoursId: businessHours.id,
      },
    });

    // Web chat and email work immediately; a tenant configures provider
    // credentials later, and the local mail driver covers development.
    await tx.channelAccount.createMany({
      data: [
        {
          id: newId('channelAccount'),
          organizationId,
          workspaceId: workspace.id,
          channel: 'web_chat',
          name: 'Website chat',
          queueId: queue.id,
          config: { greeting: 'Hello! How can we help today?' },
        },
        {
          id: newId('channelAccount'),
          organizationId,
          workspaceId: workspace.id,
          channel: 'email',
          name: 'Support inbox',
          queueId: queue.id,
          config: { signature: `The ${input.name} support team` },
        },
      ],
    });

    await tx.knowledgeBase.create({
      data: {
        id: newId('knowledgeBase'),
        organizationId,
        workspaceId: workspace.id,
        name: 'General knowledge',
        key: 'general',
        description: 'Default knowledge base used to ground AI answers',
        locale: input.locale ?? 'en',
      },
    });

    await tx.guardrailPolicy.create({
      data: {
        id: newId('guardrail'),
        organizationId,
        name: 'Default guardrails',
        description: 'Baseline safety controls applied to every AI agent',
        rules: DEFAULT_GUARDRAIL_RULES,
        confidenceThreshold: 0.7,
        groundednessMode: 'flag',
        maskPii: true,
        isDefault: true,
      },
    });

    await tx.governancePolicy.create({
      data: { id: newId('governance'), organizationId, dataRetentionDays: 365 },
    });

    await tx.ticketCounter.create({ data: { organizationId, nextNumber: 1 } });

    return { organization, membership, role: ownerRole, workspace };
  }

  private async uniqueSlug(tx: Prisma.TransactionClient, source: string): Promise<string> {
    const base =
      source
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'org';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await tx.organization.findUnique({ where: { slug: candidate } });
      if (!taken) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  // ── Organization ───────────────────────────────────────────────────────────

  async getOrganization(organizationId: string) {
    return this.prisma.raw.organization.findUniqueOrThrow({ where: { id: organizationId } });
  }

  async updateOrganization(organizationId: string, patch: Record<string, unknown>) {
    const before = await this.getOrganization(organizationId);
    const after = await this.prisma.raw.organization.update({
      where: { id: organizationId },
      data: patch as never,
    });
    await this.audit.recordDiff('organization.updated', 'organization', organizationId, before as never, after as never);
    await this.redis.delByPrefix(this.redis.key(organizationId, 'org'));
    return after;
  }

  /** Organizations the signed-in user can switch between. */
  async listForUser(userId: string) {
    const memberships = await this.prisma.raw.membership.findMany({
      where: { userId },
      include: { organization: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      plan: m.organization.plan,
      logoUrl: m.organization.logoUrl,
      role: m.role.key,
      isOwner: m.isOwner,
    }));
  }

  // ── Workspaces ─────────────────────────────────────────────────────────────

  async listWorkspaces(organizationId: string) {
    return this.prisma.db.workspace.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async createWorkspace(input: { name: string; slug?: string; environment?: string; description?: string }) {
    const organizationId = RequestContextStore.organizationId()!;
    const slug = (input.slug ?? input.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const existing = await this.prisma.db.workspace.findFirst({ where: { organizationId, slug } });
    if (existing) throw AppError.conflict(`A workspace with the slug "${slug}" already exists`);

    const workspace = await this.prisma.db.workspace.create({
      data: {
        id: newId('workspace'),
        name: input.name,
        slug,
        description: input.description ?? null,
        environment: (input.environment ?? 'production') as never,
      } as never,
    });
    await this.audit.record({ action: 'workspace.created', resourceType: 'workspace', resourceId: workspace.id, after: workspace });
    return workspace;
  }

  async getWorkspace(workspaceId: string) {
    const workspace = await this.prisma.db.workspace.findFirst({ where: { id: workspaceId } });
    if (!workspace) throw AppError.notFound('Workspace', workspaceId);
    return workspace;
  }

  async updateWorkspace(workspaceId: string, patch: Record<string, unknown>) {
    const before = await this.getWorkspace(workspaceId);
    const after = await this.prisma.db.workspace.update({ where: { id: workspaceId }, data: patch as never });
    await this.audit.recordDiff('workspace.updated', 'workspace', workspaceId, before as never, after as never);
    return after;
  }

  async deleteWorkspace(workspaceId: string) {
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace.isDefault) throw AppError.conflict('The default workspace cannot be deleted');
    await this.prisma.db.workspace.delete({ where: { id: workspaceId } });
    await this.audit.record({ action: 'workspace.deleted', resourceType: 'workspace', resourceId: workspaceId, before: workspace });
  }
}

/** Baseline guardrail configuration applied to every new tenant. */
const DEFAULT_GUARDRAIL_RULES = [
  { stage: 'input', check: 'prompt_injection', action: 'handoff', severity: 'high' },
  { stage: 'input', check: 'max_length', action: 'block', severity: 'low', config: { maxChars: 8000 } },
  { stage: 'tool', check: 'authorization', action: 'block', severity: 'high' },
  { stage: 'tool', check: 'egress_allowlist', action: 'block', severity: 'high' },
  { stage: 'output', check: 'pii', action: 'mask', severity: 'medium' },
  { stage: 'output', check: 'content_policy', action: 'block', severity: 'high' },
  { stage: 'output', check: 'groundedness', action: 'flag', severity: 'medium' },
  { stage: 'decision', check: 'confidence', action: 'handoff', severity: 'medium' },
] as const;
