import { Injectable } from '@nestjs/common';
import { Prisma, type ExecutionStatus } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { MetricsService } from '../../core/metrics/metrics.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { NodeExecutors, type NodeExecutionResult, type NodeRuntimeContext } from './nodes/node-executors';
import { NODE_TYPES, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from './graph';
import { evaluateCondition } from './expressions';

export interface StartExecutionInput {
  workflowVersionId?: string;
  agentId?: string;
  agentVersionId?: string;
  conversationId?: string;
  triggerType: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
}

/** Guards against a runaway workflow consuming a worker indefinitely. */
const MAX_STEPS = 200;

/**
 * The durable workflow interpreter.
 *
 * Every step transition is persisted before the next node runs, so an execution
 * survives a process restart and resumes exactly where it stopped. Long waits —
 * a human handoff, a timer, an external callback — suspend the execution and
 * release the worker rather than blocking it.
 */
@Injectable()
export class RuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executors: NodeExecutors,
    private readonly events: EventBus,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  // ── Starting ───────────────────────────────────────────────────────────────

  async start(input: StartExecutionInput): Promise<{ executionId: string; status: ExecutionStatus }> {
    const organizationId = RequestContextStore.organizationId()!;

    // An idempotency key makes retrying a trigger safe: the same key returns
    // the original execution instead of running the workflow twice.
    if (input.idempotencyKey) {
      const existing = await this.prisma.db.execution.findFirst({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return { executionId: existing.id, status: existing.status };
    }

    const execution = await this.prisma.db.execution.create({
      data: {
        id: newId('execution'),
        workflowVersionId: input.workflowVersionId ?? null,
        workflowId: input.workflowVersionId
          ? (await this.prisma.db.workflowVersion.findFirst({ where: { id: input.workflowVersionId }, select: { workflowId: true } }))?.workflowId ?? null
          : null,
        agentId: input.agentId ?? null,
        agentVersionId: input.agentVersionId ?? null,
        conversationId: input.conversationId ?? null,
        triggerType: input.triggerType,
        idempotencyKey: input.idempotencyKey ?? null,
        status: 'queued',
        input: input.input as Prisma.InputJsonValue,
        state: {} as Prisma.InputJsonValue,
      } as never,
    });

    await this.events.publish(DomainEvent.ExecutionStarted, { type: 'execution', id: execution.id }, {
      executionId: execution.id,
      workflowId: execution.workflowId,
      version: input.workflowVersionId,
    }, { organizationId });

    return { executionId: execution.id, status: execution.status };
  }

  // ── Running ────────────────────────────────────────────────────────────────

  /**
   * Drive an execution until it finishes, fails or suspends.
   *
   * The loop reloads nothing from memory between steps: the durable record is
   * the source of truth, which is what makes resumption after a crash correct
   * rather than approximate.
   */
  async run(executionId: string): Promise<ExecutionStatus> {
    const execution = await this.prisma.db.execution.findFirst({
      where: { id: executionId },
      include: { workflowVersion: true },
    });
    if (!execution) throw AppError.notFound('Execution', executionId);
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(execution.status)) return execution.status;

    const version = execution.workflowVersion;
    if (!version) {
      await this.fail(executionId, 'The execution has no workflow version to run');
      return 'failed';
    }

    const graph = version.graph as unknown as WorkflowGraph;
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

    const startedAt = execution.startedAt ?? new Date();
    const deadline = startedAt.getTime() + version.timeoutSeconds * 1000;

    await this.prisma.db.execution.update({
      where: { id: executionId },
      data: { status: 'running', startedAt },
    });

    let state = { ...(execution.state as Record<string, unknown>) };
    let currentId = execution.currentNodeId ?? this.entryNodeId(graph);
    let sequence = await this.prisma.db.executionStep.count({ where: { executionId } });
    let promptTokens = execution.promptTokens;
    let completionTokens = execution.completionTokens;
    let costUsd = Number(execution.costUsd);

    while (currentId) {
      if (sequence >= MAX_STEPS) {
        await this.fail(executionId, `The workflow exceeded ${MAX_STEPS} steps and was stopped`, currentId);
        return 'failed';
      }
      if (Date.now() > deadline) {
        await this.finish(executionId, 'timed_out', { error: 'The workflow exceeded its timeout' });
        return 'timed_out';
      }

      // Cancellation is cooperative and checked between nodes.
      const liveStatus = await this.prisma.db.execution.findFirst({
        where: { id: executionId },
        select: { status: true },
      });
      if (liveStatus?.status === 'cancelled') return 'cancelled';

      const node = nodesById.get(currentId);
      if (!node) {
        await this.fail(executionId, `The workflow references an unknown node "${currentId}"`, currentId);
        return 'failed';
      }

      sequence += 1;
      const step = await this.prisma.db.executionStep.create({
        data: {
          id: newId('step'),
          executionId,
          sequence,
          nodeId: node.id,
          nodeType: node.type,
          nodeName: node.name ?? null,
          status: 'running',
          input: this.snapshot(state) as Prisma.InputJsonValue,
        } as never,
      });

      const context: NodeRuntimeContext = {
        executionId,
        stepId: step.id,
        conversationId: execution.conversationId ?? undefined,
        agentId: execution.agentId ?? undefined,
        agentVersionId: execution.agentVersionId ?? undefined,
        state,
        input: execution.input as Record<string, unknown>,
      };

      let result: NodeExecutionResult;
      const stepStarted = Date.now();
      try {
        result = await this.executors.execute(node, context);
      } catch (error) {
        result = {
          output: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const durationMs = Date.now() - stepStarted;

      promptTokens += result.usage?.promptTokens ?? 0;
      completionTokens += result.usage?.completionTokens ?? 0;
      costUsd += result.usage?.costUsd ?? 0;

      await this.prisma.db.executionStep.update({
        where: { id: step.id },
        data: {
          status: result.error ? 'failed' : 'succeeded',
          output: (result.output ?? null) as Prisma.InputJsonValue,
          error: result.error ?? null,
          logs: (result.logs ?? []) as Prisma.InputJsonValue,
          promptTokens: result.usage?.promptTokens ?? 0,
          completionTokens: result.usage?.completionTokens ?? 0,
          costUsd: new Prisma.Decimal((result.usage?.costUsd ?? 0).toFixed(6)),
          model: result.usage?.model ?? null,
          finishedAt: new Date(),
          durationMs,
        },
      });

      await this.events.publish(DomainEvent.ExecutionStepFinished, { type: 'execution', id: executionId }, {
        executionId,
        nodeId: node.id,
        status: result.error ? 'failed' : 'succeeded',
        durationMs,
      });

      // Node output is addressable by node id, so later nodes can reference it.
      state = {
        ...state,
        [node.id]: result.output,
        last: result.output,
        ...(result.statePatch ?? {}),
      };

      if (result.error) {
        // An error edge lets a workflow handle failure itself.
        const errorEdge = graph.edges.find((edge) => edge.from === node.id && edge.branch === 'error');
        if (!errorEdge) {
          this.metrics.workflowFailures.inc({ workflow: execution.workflowId ?? 'inline', node_type: node.type });
          await this.fail(executionId, result.error, node.id, state, { promptTokens, completionTokens, costUsd });
          return 'failed';
        }
        currentId = errorEdge.to;
        await this.persistProgress(executionId, currentId, state, { promptTokens, completionTokens, costUsd });
        continue;
      }

      if (result.suspend) {
        await this.suspend(executionId, node.id, state, result.suspend, { promptTokens, completionTokens, costUsd });
        return 'suspended';
      }

      if (result.terminal) {
        await this.finish(executionId, 'succeeded', { output: result.output, state }, { promptTokens, completionTokens, costUsd });
        return 'succeeded';
      }

      const nextId = this.nextNode(graph, node, result, state);
      if (!nextId) {
        await this.finish(executionId, 'succeeded', { output: result.output, state }, { promptTokens, completionTokens, costUsd });
        return 'succeeded';
      }

      currentId = nextId;
      await this.persistProgress(executionId, currentId, state, { promptTokens, completionTokens, costUsd });
    }

    await this.finish(executionId, 'succeeded', { state }, { promptTokens, completionTokens, costUsd });
    return 'succeeded';
  }

  /** Pick the outgoing edge to follow, honouring branches and conditions. */
  private nextNode(graph: WorkflowGraph, node: WorkflowNode, result: NodeExecutionResult, state: Record<string, unknown>): string | null {
    const outgoing = graph.edges.filter((edge) => edge.from === node.id && edge.branch !== 'error');
    if (!outgoing.length) return null;

    // A node that names a branch takes that edge, if it exists.
    if (result.branch) {
      const branched = outgoing.find((edge) => edge.branch === result.branch);
      if (branched) return branched.to;
    }

    const scope = { ...state, output: result.output, input: state.input };
    for (const edge of outgoing) {
      if (!edge.condition) continue;
      try {
        if (evaluateCondition(edge.condition, scope)) return edge.to;
      } catch (error) {
        this.logger.warn('Edge condition failed to evaluate; skipping the edge', {
          edge: edge.id,
          reason: String(error),
        });
      }
    }

    // Fall through to the first unconditioned edge — the default path.
    return outgoing.find((edge) => !edge.condition && !edge.branch)?.to ?? outgoing[0].to;
  }

  private entryNodeId(graph: WorkflowGraph): string | null {
    const trigger = graph.nodes.find((node) => NODE_TYPES[node.type] === 'trigger');
    if (!trigger) return graph.nodes[0]?.id ?? null;
    const first = graph.edges.find((edge) => edge.from === trigger.id);
    return first?.to ?? null;
  }

  /** Persist just enough that a crash here resumes correctly. */
  private async persistProgress(
    executionId: string,
    nodeId: string,
    state: Record<string, unknown>,
    usage: { promptTokens: number; completionTokens: number; costUsd: number },
  ) {
    await this.prisma.db.execution.update({
      where: { id: executionId },
      data: {
        currentNodeId: nodeId,
        state: this.snapshot(state) as Prisma.InputJsonValue,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costUsd: new Prisma.Decimal(usage.costUsd.toFixed(6)),
      },
    });
  }

  // ── Suspend and resume ─────────────────────────────────────────────────────

  private async suspend(
    executionId: string,
    nodeId: string,
    state: Record<string, unknown>,
    suspend: { reason: string; resumeAfter?: Date },
    usage: { promptTokens: number; completionTokens: number; costUsd: number },
  ) {
    const resumeToken = newId('token');
    await this.prisma.db.execution.update({
      where: { id: executionId },
      data: {
        status: 'suspended',
        currentNodeId: nodeId,
        state: this.snapshot(state) as Prisma.InputJsonValue,
        suspendReason: suspend.reason,
        resumeToken,
        resumeAfter: suspend.resumeAfter ?? null,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costUsd: new Prisma.Decimal(usage.costUsd.toFixed(6)),
      },
    });

    await this.events.publish(DomainEvent.ExecutionSuspended, { type: 'execution', id: executionId }, {
      executionId,
      reason: suspend.reason,
      resumeToken,
    });
  }

  /**
   * Resume a suspended execution. Advancing past the suspending node before
   * running means a resume cannot re-trigger the same wait.
   */
  async resume(executionId: string, payload: Record<string, unknown> = {}): Promise<ExecutionStatus> {
    const execution = await this.prisma.db.execution.findFirst({
      where: { id: executionId },
      include: { workflowVersion: true },
    });
    if (!execution) throw AppError.notFound('Execution', executionId);
    if (execution.status !== 'suspended') {
      throw AppError.conflict(`Only a suspended execution can be resumed; this one is ${execution.status}`);
    }

    const graph = execution.workflowVersion?.graph as unknown as WorkflowGraph | undefined;
    const nextId = graph && execution.currentNodeId
      ? graph.edges.find((edge: WorkflowEdge) => edge.from === execution.currentNodeId && edge.branch !== 'error')?.to
      : undefined;

    await this.prisma.db.execution.update({
      where: { id: executionId },
      data: {
        status: 'running',
        currentNodeId: nextId ?? null,
        resumeToken: null,
        resumeAfter: null,
        suspendReason: null,
        state: { ...(execution.state as object), resume: payload } as Prisma.InputJsonValue,
      },
    });

    if (!nextId) {
      await this.finish(executionId, 'succeeded', { resumedWith: payload });
      return 'succeeded';
    }
    return this.run(executionId);
  }

  async resumeByToken(resumeToken: string, payload: Record<string, unknown> = {}): Promise<ExecutionStatus> {
    const execution = await this.prisma.raw.execution.findUnique({ where: { resumeToken } });
    if (!execution) throw AppError.notFound('Execution');
    return RequestContextStore.runAsSystem(() => this.resume(execution.id, payload), execution.organizationId);
  }

  /** Resume executions whose timers have elapsed. Runs on the worker tier. */
  async resumeDue(limit = 50): Promise<number> {
    const due = await this.prisma.raw.execution.findMany({
      where: { status: 'suspended', resumeAfter: { lte: new Date() } },
      take: limit,
      select: { id: true, organizationId: true },
    });

    let resumed = 0;
    for (const execution of due) {
      try {
        await RequestContextStore.runAsSystem(() => this.resume(execution.id), execution.organizationId);
        resumed += 1;
      } catch (error) {
        this.logger.error('Failed to resume a due execution', error, { executionId: execution.id });
      }
    }
    return resumed;
  }

  // ── Termination ────────────────────────────────────────────────────────────

  private async fail(
    executionId: string,
    error: string,
    nodeId?: string,
    state?: Record<string, unknown>,
    usage?: { promptTokens: number; completionTokens: number; costUsd: number },
  ) {
    await this.prisma.db.execution.update({
      where: { id: executionId },
      data: {
        status: 'failed',
        error: error.slice(0, 2000),
        errorNodeId: nodeId ?? null,
        finishedAt: new Date(),
        ...(state ? { state: this.snapshot(state) as Prisma.InputJsonValue } : {}),
        ...(usage
          ? {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              costUsd: new Prisma.Decimal(usage.costUsd.toFixed(6)),
            }
          : {}),
      },
    });

    this.logger.warn('Workflow execution failed', { executionId, nodeId, error });
    await this.events.publish(DomainEvent.ExecutionFailed, { type: 'execution', id: executionId }, {
      executionId,
      nodeId,
      error,
    });
  }

  private async finish(
    executionId: string,
    status: ExecutionStatus,
    output: Record<string, unknown>,
    usage?: { promptTokens: number; completionTokens: number; costUsd: number },
  ) {
    const execution = await this.prisma.db.execution.findFirst({ where: { id: executionId }, select: { startedAt: true } });
    const finishedAt = new Date();

    await this.prisma.db.execution.update({
      where: { id: executionId },
      data: {
        status,
        output: this.snapshot(output) as Prisma.InputJsonValue,
        finishedAt,
        durationMs: execution?.startedAt ? finishedAt.getTime() - execution.startedAt.getTime() : null,
        ...(usage
          ? {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              costUsd: new Prisma.Decimal(usage.costUsd.toFixed(6)),
            }
          : {}),
      },
    });

    await this.events.publish(DomainEvent.ExecutionFinished, { type: 'execution', id: executionId }, {
      executionId,
      status,
      tokens: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
      costUsd: usage?.costUsd ?? 0,
    });
  }

  async cancel(executionId: string): Promise<void> {
    await this.prisma.db.execution.updateMany({
      where: { id: executionId, status: { in: ['queued', 'running', 'suspended'] } },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
  }

  // ── Inspection ─────────────────────────────────────────────────────────────

  /** Everything the execution debugger shows for one run. */
  async debug(executionId: string) {
    const execution = await this.prisma.db.execution.findFirst({
      where: { id: executionId },
      include: {
        steps: { orderBy: { sequence: 'asc' } },
        workflowVersion: { select: { version: true, graph: true } },
        agent: { select: { id: true, name: true } },
      },
    });
    if (!execution) throw AppError.notFound('Execution', executionId);

    const toolCalls = await this.prisma.db.toolInvocation.findMany({
      where: { executionId },
      orderBy: { createdAt: 'asc' },
    });
    const guardrails = await this.prisma.db.guardrailEvent.findMany({
      where: { executionId },
      orderBy: { createdAt: 'asc' },
    });

    return {
      execution: {
        id: execution.id,
        status: execution.status,
        triggerType: execution.triggerType,
        input: execution.input,
        output: execution.output,
        error: execution.error,
        errorNodeId: execution.errorNodeId,
        suspendReason: execution.suspendReason,
        durationMs: execution.durationMs,
        promptTokens: execution.promptTokens,
        completionTokens: execution.completionTokens,
        costUsd: Number(execution.costUsd),
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
      },
      agent: execution.agent,
      workflowVersion: execution.workflowVersion?.version,
      steps: execution.steps.map((step) => ({
        sequence: step.sequence,
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        nodeName: step.nodeName,
        status: step.status,
        input: step.input,
        output: step.output,
        error: step.error,
        logs: step.logs,
        model: step.model,
        promptTokens: step.promptTokens,
        completionTokens: step.completionTokens,
        costUsd: Number(step.costUsd),
        durationMs: step.durationMs,
      })),
      toolCalls,
      guardrails,
    };
  }

  async list(params: { status?: string; agentId?: string; conversationId?: string; limit?: number }) {
    return this.prisma.db.execution.findMany({
      where: {
        ...(params.status ? { status: params.status as never } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.conversationId ? { conversationId: params.conversationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(params.limit ?? 50, 200),
      select: {
        id: true, status: true, triggerType: true, agentId: true, conversationId: true,
        durationMs: true, promptTokens: true, completionTokens: true, costUsd: true,
        error: true, createdAt: true, finishedAt: true,
      },
    });
  }

  /**
   * Bound what is written to the durable state. An unbounded state document
   * would grow with every retrieved passage and eventually break the row.
   */
  private snapshot(value: unknown, depth = 0): unknown {
    if (depth > 6 || value === null || value === undefined) return value ?? null;
    if (typeof value === 'string') return value.length > 20_000 ? `${value.slice(0, 20_000)}…[truncated]` : value;
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => this.snapshot(item, depth + 1));
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value).slice(0, 100)) out[key] = this.snapshot(item, depth + 1);
      return out;
    }
    return value;
  }
}
