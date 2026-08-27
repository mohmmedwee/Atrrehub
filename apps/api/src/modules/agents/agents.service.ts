import { Injectable } from '@nestjs/common';
import { Prisma, type Environment } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { isPublishable, validateGraph, type WorkflowGraph } from '../workflows/graph';
import { RuntimeService } from '../workflows/runtime.service';

export interface AgentVersionInput {
  instructions: string;
  modelRole?: 'chat' | 'fast' | 'reasoning';
  modelOverride?: string;
  temperature?: number;
  maxTokens?: number;
  knowledgeBaseIds?: string[];
  toolIds?: string[];
  workflowId?: string;
  memoryPolicy?: Record<string, unknown>;
  guardrailPolicyId?: string;
  handoffRules?: Record<string, unknown>;
  greeting?: string;
  fallbackMessage?: string;
  locales?: string[];
}

/**
 * AI agent configuration and publishing.
 *
 * An agent has one draft version being edited and one active version serving
 * traffic. Published versions are immutable, so a conversation that started on
 * v11 is never silently answered by v12 halfway through.
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly runtime: RuntimeService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  // ── Agents ─────────────────────────────────────────────────────────────────

  async list() {
    return this.prisma.db.agent.findMany({
      where: {},
      include: {
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { version: true, publishedAt: true, environment: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async create(
    input: {
      name: string;
      key: string;
      description?: string;
      workspaceId?: string;
    } & Partial<AgentVersionInput>,
  ) {
    const existing = await this.prisma.db.agent.findFirst({ where: { key: input.key } });
    if (existing) throw AppError.conflict(`An agent with the key "${input.key}" already exists`);

    const agentId = newId('agent');
    const organizationId = RequestContextStore.organizationId()!;
    const principal = RequestContextStore.principal();

    const agent = await this.prisma.raw.$transaction(async (tx) => {
      const created = await tx.agent.create({
        data: {
          id: agentId,
          organizationId,
          workspaceId: input.workspaceId ?? null,
          name: input.name,
          key: input.key,
          description: input.description ?? null,
          createdById: principal?.id ?? null,
        },
      });

      const version = await tx.agentVersion.create({
        data: {
          id: newId('agentVersion'),
          organizationId,
          agentId,
          version: 1,
          createdById: principal?.id ?? null,
          instructions:
            input.instructions ??
            'You are a helpful customer support agent. Answer using the knowledge provided, and hand off to a human when you are unsure.',
          modelRole: (input.modelRole ?? 'chat') as never,
          temperature: input.temperature ?? 0.3,
          maxTokens: input.maxTokens ?? 1024,
          knowledgeBaseIds: input.knowledgeBaseIds ?? [],
          toolIds: input.toolIds ?? [],
          workflowId: input.workflowId ?? null,
          memoryPolicy: (input.memoryPolicy ?? {
            shortTerm: true,
            longTerm: false,
          }) as Prisma.InputJsonValue,
          guardrailPolicyId: input.guardrailPolicyId ?? null,
          handoffRules: (input.handoffRules ?? {
            confidenceThreshold: 0.7,
            onRequest: true,
          }) as Prisma.InputJsonValue,
          greeting: input.greeting ?? null,
          fallbackMessage: input.fallbackMessage ?? null,
          locales: input.locales ?? ['en'],
          environment: 'development',
        },
      });

      await tx.agent.update({ where: { id: agentId }, data: { draftVersionId: version.id } });
      return created;
    });

    await this.audit.record({
      action: 'agent.created',
      resourceType: 'agent',
      resourceId: agentId,
      after: { name: input.name },
    });
    return this.get(agent.id);
  }

  async get(agentId: string) {
    const agent = await this.prisma.db.agent.findFirst({
      where: { id: agentId },
      include: { versions: { orderBy: { version: 'desc' }, take: 20 } },
    });
    if (!agent) throw AppError.notFound('Agent', agentId);

    const active = agent.versions.find((version) => version.id === agent.activeVersionId);
    const draft = agent.versions.find((version) => version.id === agent.draftVersionId);
    return { ...agent, activeVersion: active ?? null, draftVersion: draft ?? null };
  }

  /**
   * Edit the draft. A published version is never modified — editing after a
   * publish forks a new draft, so what is live stays exactly as it was reviewed.
   */
  async updateDraft(agentId: string, patch: Partial<AgentVersionInput>) {
    const agent = await this.get(agentId);
    const organizationId = RequestContextStore.organizationId()!;

    if (agent.draftVersion && !agent.draftVersion.publishedAt) {
      const updated = await this.prisma.db.agentVersion.update({
        where: { id: agent.draftVersion.id },
        data: patch as never,
      });
      return updated;
    }

    const base = agent.activeVersion ?? agent.versions[0];
    const nextVersion = Math.max(0, ...agent.versions.map((version) => version.version)) + 1;

    const draft = await this.prisma.raw.agentVersion.create({
      data: {
        id: newId('agentVersion'),
        organizationId,
        agentId,
        version: nextVersion,
        createdById: RequestContextStore.principal()?.id ?? null,
        instructions: patch.instructions ?? base?.instructions ?? '',
        modelRole: (patch.modelRole ?? base?.modelRole ?? 'chat') as never,
        modelOverride: patch.modelOverride ?? base?.modelOverride ?? null,
        temperature: patch.temperature ?? base?.temperature ?? 0.3,
        maxTokens: patch.maxTokens ?? base?.maxTokens ?? 1024,
        knowledgeBaseIds: patch.knowledgeBaseIds ?? base?.knowledgeBaseIds ?? [],
        toolIds: patch.toolIds ?? base?.toolIds ?? [],
        workflowId: patch.workflowId ?? base?.workflowId ?? null,
        memoryPolicy: (patch.memoryPolicy ?? base?.memoryPolicy ?? {}) as Prisma.InputJsonValue,
        guardrailPolicyId: patch.guardrailPolicyId ?? base?.guardrailPolicyId ?? null,
        handoffRules: (patch.handoffRules ?? base?.handoffRules ?? {}) as Prisma.InputJsonValue,
        greeting: patch.greeting ?? base?.greeting ?? null,
        fallbackMessage: patch.fallbackMessage ?? base?.fallbackMessage ?? null,
        locales: patch.locales ?? base?.locales ?? ['en'],
        environment: 'development',
      },
    });

    await this.prisma.db.agent.update({
      where: { id: agentId },
      data: { draftVersionId: draft.id },
    });
    return draft;
  }

  /**
   * Publish the draft into an environment.
   *
   * Promotion to production requires the agent's gate evaluations to have
   * passed — the point of an evaluation suite is that it can say no.
   */
  async publish(agentId: string, environment: Environment = 'production') {
    const agent = await this.get(agentId);
    const draft = agent.draftVersion;
    if (!draft) throw AppError.conflict('There is no draft version to publish');

    if (draft.workflowId) {
      const workflow = await this.prisma.db.workflow.findFirst({
        where: { id: draft.workflowId },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      const graph = workflow?.versions[0]?.graph as unknown as WorkflowGraph | undefined;
      if (!graph)
        throw AppError.conflict('The workflow attached to this agent has no version to run');
      const issues = validateGraph(graph);
      if (!isPublishable(issues)) {
        throw AppError.badRequest(
          `The attached workflow is not valid: ${issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => issue.message)
            .join('; ')}`,
        );
      }
    }

    if (environment === 'production') {
      const gates = await this.prisma.db.evaluationDataset.findMany({
        where: { agentId, isGate: true },
        include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
      });
      const failing = gates.filter((gate) => !gate.runs[0]?.passed);
      if (failing.length) {
        throw AppError.conflict(
          `Promotion is blocked by ${failing.length} evaluation gate(s): ${failing.map((gate) => gate.name).join(', ')}`,
          { gates: failing.map((gate) => gate.name) },
        );
      }
    }

    const principal = RequestContextStore.principal();
    await this.assertApprovalSatisfied(draft, principal?.id);

    const published = await this.prisma.raw.$transaction(async (tx) => {
      const version = await tx.agentVersion.update({
        where: { id: draft.id },
        data: { publishedAt: new Date(), publishedById: principal?.id ?? null, environment },
      });
      await tx.agent.update({
        where: { id: agentId },
        data: { activeVersionId: version.id, draftVersionId: null, state: 'published' },
      });
      return version;
    });

    await this.events.publish(
      DomainEvent.AgentPublished,
      { type: 'agent', id: agentId },
      {
        agentId,
        version: published.version,
        environment,
      },
    );
    await this.audit.record({
      action: 'agent.published',
      resourceType: 'agent',
      resourceId: agentId,
      after: { version: published.version, environment },
    });
    return published;
  }

  /**
   * Four-eyes on publication, when the tenant's governance policy asks for it.
   *
   * The field has existed since the schema was written and enforced nothing, so
   * an organization that switched it on got no second pair of eyes at all —
   * which is worse than not offering it, because somebody believed they had it.
   *
   * A draft with no recorded author predates this being tracked. It is allowed
   * through rather than blocked: refusing would strand every agent written
   * before the column existed, and the policy is about the *next* change.
   */
  private async assertApprovalSatisfied(
    draft: { id: string; createdById: string | null },
    publisherId: string | undefined,
  ): Promise<void> {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return;

    const policy = await this.redis.remember(
      this.redis.key(organizationId, 'governance'),
      300,
      async () => this.prisma.raw.governancePolicy.findUnique({ where: { organizationId } }),
    );
    if (!policy?.requireHumanApproval) return;

    if (!publisherId) {
      throw AppError.policyBlocked(
        'human_approval_required',
        'This organization requires a person to approve a publication, and this request has no user behind it',
      );
    }
    if (draft.createdById && draft.createdById === publisherId) {
      throw AppError.policyBlocked(
        'human_approval_required',
        'This organization requires a second person to publish: you wrote this draft, so somebody else must approve it',
      );
    }
  }

  /** Roll back to a previously published version. */
  async rollback(agentId: string, version: number) {
    const target = await this.prisma.db.agentVersion.findFirst({ where: { agentId, version } });
    if (!target) throw AppError.notFound('Agent version', String(version));
    if (!target.publishedAt)
      throw AppError.conflict('Only a previously published version can be rolled back to');

    await this.prisma.db.agent.update({
      where: { id: agentId },
      data: { activeVersionId: target.id },
    });
    await this.audit.record({
      action: 'agent.rolled_back',
      resourceType: 'agent',
      resourceId: agentId,
      after: { version },
    });
    return target;
  }

  async delete(agentId: string) {
    const inUse = await this.prisma.db.queue.count({ where: { aiAgentId: agentId } });
    if (inUse) throw AppError.conflict(`${inUse} queue(s) still route to this agent`);
    await this.prisma.db.agent.delete({ where: { id: agentId } });
    await this.audit.record({
      action: 'agent.deleted',
      resourceType: 'agent',
      resourceId: agentId,
    });
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  /**
   * Run an agent against an input. When the agent has a workflow, the runtime
   * drives it; otherwise a single grounded answer is produced from a synthetic
   * one-node graph, so both paths share the same debugger and accounting.
   */
  async run(input: {
    agentId: string;
    message: string;
    conversationId?: string;
    customerId?: string;
    idempotencyKey?: string;
  }) {
    const agent = await this.get(input.agentId);
    const version = agent.activeVersion ?? agent.draftVersion;
    if (!version) throw AppError.conflict('This agent has no version to run');

    const workflowVersionId = version.workflowId
      ? (
          await this.prisma.db.workflowVersion.findFirst({
            where: { workflowId: version.workflowId },
            orderBy: { version: 'desc' },
            select: { id: true },
          })
        )?.id
      : await this.ensureInlineWorkflow(version);

    const { executionId } = await this.runtime.start({
      workflowVersionId: workflowVersionId ?? undefined,
      agentId: agent.id,
      agentVersionId: version.id,
      conversationId: input.conversationId,
      triggerType: 'agent.run',
      input: {
        message: input.message,
        customerId: input.customerId,
        conversationId: input.conversationId,
      },
      idempotencyKey: input.idempotencyKey,
    });

    const status = await this.runtime.run(executionId);
    const execution = await this.prisma.db.execution.findFirst({ where: { id: executionId } });

    return {
      executionId,
      status,
      output: execution?.output ?? null,
      promptTokens: execution?.promptTokens ?? 0,
      completionTokens: execution?.completionTokens ?? 0,
      costUsd: Number(execution?.costUsd ?? 0),
      durationMs: execution?.durationMs ?? null,
    };
  }

  /**
   * A minimal trigger → agent → send → handoff graph for agents configured
   * without a custom workflow. Cached per agent version, since the version is
   * immutable once published.
   */
  private async ensureInlineWorkflow(version: {
    id: string;
    agentId: string;
    instructions: string;
    knowledgeBaseIds: string[];
    guardrailPolicyId: string | null;
    temperature: number;
    fallbackMessage: string | null;
  }): Promise<string> {
    const organizationId = RequestContextStore.organizationId()!;
    const key = `agent-inline-${version.id}`;

    const existing = await this.prisma.db.workflow.findFirst({
      where: { key },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (existing?.versions[0]) return existing.versions[0].id;

    const graph: WorkflowGraph = {
      nodes: [
        { id: 'trigger', type: 'trigger.message_received', name: 'Message received', config: {} },
        {
          id: 'agent',
          type: 'ai.agent',
          name: 'Answer',
          config: {
            instructions: version.instructions,
            knowledgeBaseIds: version.knowledgeBaseIds,
            guardrailPolicyId: version.guardrailPolicyId ?? undefined,
            temperature: version.temperature,
          },
        },
        {
          id: 'reply',
          type: 'action.send_message',
          name: 'Reply',
          config: { body: '{{ answer }}' },
        },
        {
          id: 'handoff',
          type: 'human.handoff',
          name: 'Hand to a human',
          config: { reason: '{{ handoffReason }}', summary: version.fallbackMessage ?? undefined },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'agent' },
        { id: 'e2', from: 'agent', to: 'reply', branch: 'answered' },
        { id: 'e3', from: 'agent', to: 'handoff', branch: 'handoff' },
        { id: 'e4', from: 'agent', to: 'handoff', branch: 'blocked' },
      ],
    };

    const workflowId = newId('workflow');
    const versionId = newId('workflowVersion');

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.workflow.create({
        data: {
          id: workflowId,
          organizationId,
          name: `Inline workflow for agent version ${version.id}`,
          key,
          state: 'published',
          activeVersionId: versionId,
        },
      });
      await tx.workflowVersion.create({
        data: {
          id: versionId,
          organizationId,
          workflowId,
          version: 1,
          graph: graph as unknown as Prisma.InputJsonValue,
          publishedAt: new Date(),
        },
      });
    });

    return versionId;
  }
}
