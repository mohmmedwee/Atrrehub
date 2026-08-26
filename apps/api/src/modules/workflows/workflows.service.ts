import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NODE_TYPES, isPublishable, validateGraph, type WorkflowGraph } from './graph';

/** Workflow authoring: the storage and validation behind the visual builder. */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The node palette the builder renders, grouped by category. */
  nodeCatalog() {
    const byCategory: Record<string, { type: string; category: string }[]> = {};
    for (const [type, category] of Object.entries(NODE_TYPES)) {
      byCategory[category] ??= [];
      byCategory[category].push({ type, category });
    }
    return byCategory;
  }

  async list() {
    return this.prisma.db.workflow.findMany({
      where: { key: { not: { startsWith: 'agent-inline-' } } },
      include: { versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, publishedAt: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async create(input: { name: string; key: string; description?: string; graph?: WorkflowGraph; workspaceId?: string }) {
    const existing = await this.prisma.db.workflow.findFirst({ where: { key: input.key } });
    if (existing) throw AppError.conflict(`A workflow with the key "${input.key}" already exists`);

    const organizationId = RequestContextStore.organizationId()!;
    const principal = RequestContextStore.principal();
    const workflowId = newId('workflow');

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.workflow.create({
        data: {
          id: workflowId,
          organizationId,
          workspaceId: input.workspaceId ?? null,
          name: input.name,
          key: input.key,
          description: input.description ?? null,
          createdById: principal?.id ?? null,
        },
      });
      await tx.workflowVersion.create({
        data: {
          id: newId('workflowVersion'),
          organizationId,
          workflowId,
          version: 1,
          graph: (input.graph ?? { nodes: [], edges: [] }) as unknown as Prisma.InputJsonValue,
        },
      });
    });

    return this.get(workflowId);
  }

  async get(workflowId: string) {
    const workflow = await this.prisma.db.workflow.findFirst({
      where: { id: workflowId },
      include: { versions: { orderBy: { version: 'desc' }, take: 20 } },
    });
    if (!workflow) throw AppError.notFound('Workflow', workflowId);

    const latest = workflow.versions[0];
    return {
      ...workflow,
      latestVersion: latest ?? null,
      issues: latest ? validateGraph(latest.graph as unknown as WorkflowGraph) : [],
    };
  }

  /**
   * Save the graph. An unpublished version is edited in place; editing after a
   * publish creates the next version, so what is live never changes underfoot.
   */
  async saveGraph(workflowId: string, graph: WorkflowGraph) {
    const workflow = await this.get(workflowId);
    const organizationId = RequestContextStore.organizationId()!;
    const latest = workflow.latestVersion;

    const issues = validateGraph(graph);

    if (latest && !latest.publishedAt) {
      const updated = await this.prisma.db.workflowVersion.update({
        where: { id: latest.id },
        data: { graph: graph as unknown as Prisma.InputJsonValue },
      });
      return { version: updated, issues };
    }

    const created = await this.prisma.raw.workflowVersion.create({
      data: {
        id: newId('workflowVersion'),
        organizationId,
        workflowId,
        version: (latest?.version ?? 0) + 1,
        graph: graph as unknown as Prisma.InputJsonValue,
      },
    });
    return { version: created, issues };
  }

  async publish(workflowId: string) {
    const workflow = await this.get(workflowId);
    const latest = workflow.latestVersion;
    if (!latest) throw AppError.conflict('There is no version to publish');
    if (latest.publishedAt) throw AppError.conflict('The latest version is already published');

    const issues = validateGraph(latest.graph as unknown as WorkflowGraph);
    if (!isPublishable(issues)) {
      throw AppError.badRequest(
        'The workflow has errors that must be fixed before publishing',
        issues.filter((issue) => issue.severity === 'error').map((issue) => ({ path: issue.nodeId ?? 'graph', message: issue.message })),
      );
    }

    const principal = RequestContextStore.principal();
    const published = await this.prisma.raw.$transaction(async (tx) => {
      const version = await tx.workflowVersion.update({
        where: { id: latest.id },
        data: { publishedAt: new Date(), publishedById: principal?.id ?? null },
      });
      await tx.workflow.update({ where: { id: workflowId }, data: { activeVersionId: version.id, state: 'published' } });
      return version;
    });

    await this.audit.record({
      action: 'workflow.published',
      resourceType: 'workflow',
      resourceId: workflowId,
      after: { version: published.version },
    });
    return { version: published, issues };
  }

  async validate(workflowId: string) {
    const workflow = await this.get(workflowId);
    const graph = workflow.latestVersion?.graph as unknown as WorkflowGraph | undefined;
    const issues = graph ? validateGraph(graph) : [{ severity: 'error' as const, message: 'The workflow has no version' }];
    return { issues, publishable: isPublishable(issues) };
  }

  async delete(workflowId: string) {
    const inUse = await this.prisma.db.agentVersion.count({ where: { workflowId } });
    if (inUse) throw AppError.conflict(`${inUse} agent version(s) still reference this workflow`);
    await this.prisma.db.workflow.delete({ where: { id: workflowId } });
  }
}
