import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { actorTypeFor } from '../../core/context/actor';
import { RequestContextStore } from '../../core/context/request-context';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { redact } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  organizationId?: string;
  actorId?: string;
  actorLabel?: string;
}

/**
 * Append-only audit trail. Covers every action listed in the security plan:
 * login, logout, permission changes, user changes, configuration changes, agent
 * changes, knowledge changes and sensitive data access.
 *
 * Writes never throw into the caller — losing an audit row must not fail the
 * operation that produced it, but it must be visible in the logs.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  async record(input: AuditInput): Promise<void> {
    const context = RequestContextStore.get();
    const organizationId = input.organizationId ?? context?.organizationId;
    if (!organizationId) return;

    try {
      await this.prisma.raw.auditEvent.create({
        data: {
          id: newId('audit'),
          organizationId,
          actorType: actorTypeFor(context?.principal),
          actorId: input.actorId ?? context?.principal?.id ?? null,
          actorLabel: input.actorLabel ?? context?.principal?.label ?? null,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          before: (redact(input.before) ?? null) as Prisma.InputJsonValue,
          after: (redact(input.after) ?? null) as Prisma.InputJsonValue,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
          requestId: context?.requestId ?? null,
        },
      });
    } catch (error) {
      this.logger.error('Failed to write audit event', error, { action: input.action });
    }
  }

  /**
   * Record only the fields that actually changed, so a diff of a large entity
   * stays readable and does not store unchanged secrets.
   */
  async recordDiff(
    action: string,
    resourceType: string,
    resourceId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<void> {
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changedBefore[key] = before[key];
        changedAfter[key] = after[key];
      }
    }
    if (!Object.keys(changedAfter).length) return;
    await this.record({
      action,
      resourceType,
      resourceId,
      before: changedBefore,
      after: changedAfter,
    });
  }

  async search(params: {
    organizationId: string;
    actorId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    cursor?: string;
  }) {
    const limit = Math.min(params.limit ?? 50, 200);
    const where: Prisma.AuditEventWhereInput = {
      organizationId: params.organizationId,
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.action ? { action: { contains: params.action } } : {}),
      ...(params.resourceType ? { resourceType: params.resourceType } : {}),
      ...(params.resourceId ? { resourceId: params.resourceId } : {}),
      ...(params.from || params.to
        ? {
            createdAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.db.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return { data, meta: { limit, cursor: hasMore ? (data.at(-1)?.id ?? null) : null } };
  }
}
