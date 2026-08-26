import { Injectable } from '@nestjs/common';
import { estimateCostUsd } from '../../ai/provider';
import { AiGateway } from '../../ai/gateway.service';
import { ChannelsService } from '../../channels/channels.service';
import { ConversationsService } from '../../conversations/conversations.service';
import { CustomersService } from '../../customers/customers.service';
import { GuardrailsService } from '../../guardrails/guardrails.service';
import { isEgressAllowed } from '../../guardrails/detectors';
import { KnowledgeService } from '../../knowledge/knowledge.service';
import { RagService } from '../../rag/rag.service';
import { TicketsService } from '../../tickets/tickets.service';
import { ToolsService } from '../../tools/tools.service';
import { AppLogger } from '../../../core/logger/logger.service';
import { evaluateCondition, interpolate, resolvePath } from '../expressions';
import type { WorkflowNode } from '../graph';

export interface NodeRuntimeContext {
  executionId: string;
  stepId: string;
  conversationId?: string;
  agentId?: string;
  agentVersionId?: string;
  state: Record<string, unknown>;
  input: Record<string, unknown>;
}

export interface NodeExecutionResult {
  output: unknown;
  error?: string;
  /** Named output edge to follow, for branching nodes. */
  branch?: string;
  /** Merge these keys into the execution state. */
  statePatch?: Record<string, unknown>;
  /** Stop here and release the worker until resumed. */
  suspend?: { reason: string; resumeAfter?: Date };
  /** End the execution successfully at this node. */
  terminal?: boolean;
  logs?: { level: string; message: string }[];
  usage?: { promptTokens: number; completionTokens: number; costUsd: number; model?: string };
}

/**
 * One executor per node type. Each is small and self-contained, so adding a
 * node to the visual builder is a matter of adding a case here and an entry in
 * the graph's node catalog — the runtime itself never changes.
 */
@Injectable()
export class NodeExecutors {
  constructor(
    private readonly gateway: AiGateway,
    private readonly rag: RagService,
    private readonly knowledge: KnowledgeService,
    private readonly tools: ToolsService,
    private readonly guardrails: GuardrailsService,
    private readonly conversations: ConversationsService,
    private readonly channels: ChannelsService,
    private readonly customers: CustomersService,
    private readonly tickets: TicketsService,
    private readonly logger: AppLogger,
  ) {}

  async execute(node: WorkflowNode, context: NodeRuntimeContext): Promise<NodeExecutionResult> {
    const scope = { ...context.state, input: context.input, trigger: context.input };

    switch (node.type) {
      case 'trigger.conversation_started':
      case 'trigger.message_received':
      case 'trigger.ticket_created':
      case 'trigger.webhook':
      case 'trigger.schedule':
        return { output: context.input };

      case 'ai.llm':
        return this.runLlm(node, context, scope);
      case 'ai.intent':
        return this.runClassifier(node, context, scope, 'intent');
      case 'ai.sentiment':
        return this.runSentiment(node, context, scope);
      case 'ai.classify':
        return this.runClassifier(node, context, scope, 'category');
      case 'ai.agent':
        return this.runAgentNode(node, context, scope);

      case 'knowledge.search':
      case 'knowledge.retrieve':
        return this.runKnowledge(node, context, scope);

      case 'logic.condition':
        return this.runCondition(node, scope);
      case 'logic.switch':
      case 'logic.router':
        return this.runSwitch(node, scope);
      case 'logic.set':
        return this.runSet(node, scope);
      case 'logic.delay':
        return this.runDelay(node, scope);
      case 'logic.loop':
        return this.runLoop(node, context, scope);

      case 'action.send_message':
        return this.runSendMessage(node, context, scope);
      case 'action.send_email':
        return this.runSendMessage(node, context, scope);
      case 'action.create_ticket':
        return this.runCreateTicket(node, context, scope);
      case 'action.update_ticket':
        return this.runUpdateTicket(node, scope);
      case 'action.update_customer':
        return this.runUpdateCustomer(node, context, scope);
      case 'action.http':
      case 'action.webhook':
        return this.runHttp(node, scope);
      case 'action.tool':
        return this.runTool(node, context, scope);

      case 'human.handoff':
      case 'human.transfer':
      case 'human.escalate':
        return this.runHandoff(node, context, scope);

      default:
        return { output: null, error: `No executor is registered for node type "${node.type}"` };
    }
  }

  // ── AI nodes ───────────────────────────────────────────────────────────────

  private async runLlm(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as {
      prompt?: string;
      system?: string;
      role?: 'chat' | 'fast' | 'reasoning';
      temperature?: number;
      maxTokens?: number;
      useContext?: boolean;
    };
    const prompt = interpolate(config.prompt ?? '{{ input.message }}', scope);

    // Retrieved passages, if a knowledge node ran earlier, are wrapped in
    // <context> markers the providers are prompted to ground against.
    const retrieved = (scope.context as string | undefined) ?? '';
    const system = [
      config.system ? interpolate(config.system, scope) : '',
      config.useContext !== false && retrieved ? `<context>\n${retrieved}\n</context>` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const response = await this.gateway.complete(
      {
        messages: [
          ...(system ? [{ role: 'system' as const, content: system }] : []),
          { role: 'user' as const, content: prompt },
        ],
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      },
      {
        role: config.role ?? 'chat',
        operation: 'workflow.llm',
        executionId: context.executionId,
        agentId: context.agentId,
        conversationId: context.conversationId,
      },
    );

    return {
      output: { text: response.content, confidence: response.confidence },
      statePatch: { answer: response.content, confidence: response.confidence },
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        costUsd: estimateCostUsd(
          response.model,
          response.usage.promptTokens,
          response.usage.completionTokens,
        ),
        model: response.model,
      },
    };
  }

  /** Classification into a fixed label set, with the label as the branch. */
  private async runClassifier(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
    field: 'intent' | 'category',
  ): Promise<NodeExecutionResult> {
    const config = node.config as { labels?: string[]; text?: string; instructions?: string };
    const labels = config.labels?.length
      ? config.labels
      : ['question', 'complaint', 'request', 'other'];
    const text = interpolate(config.text ?? '{{ input.message }}', scope);

    const { value, response } = await this.gateway.completeStructured<{
      label: string;
      confidence: number;
    }>(
      {
        messages: [
          {
            role: 'system',
            content: `${config.instructions ?? 'Classify the customer message.'} Choose exactly one label from: ${labels.join(', ')}.`,
          },
          { role: 'user', content: text },
        ],
        responseSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', enum: labels },
            confidence: { type: 'number', description: 'Confidence between 0 and 1' },
          },
          required: ['label'],
        },
      },
      {
        role: 'fast',
        operation: `workflow.${field}`,
        executionId: context.executionId,
        conversationId: context.conversationId,
      },
    );

    // A label outside the allowed set is a model error, not a new category.
    const label = labels.includes(value.label) ? value.label : labels[labels.length - 1];

    return {
      output: { [field]: label, confidence: value.confidence ?? response.confidence },
      branch: label,
      statePatch: { [field]: label },
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        costUsd: estimateCostUsd(
          response.model,
          response.usage.promptTokens,
          response.usage.completionTokens,
        ),
        model: response.model,
      },
    };
  }

  private async runSentiment(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as { text?: string };
    const text = interpolate(config.text ?? '{{ input.message }}', scope);

    const { value, response } = await this.gateway.completeStructured<{
      sentiment: string;
      score: number;
    }>(
      {
        messages: [
          {
            role: 'system',
            content:
              'Judge the sentiment of the customer message. score ranges from -1 (very negative) to 1 (very positive).',
          },
          { role: 'user', content: text },
        ],
        responseSchema: {
          type: 'object',
          properties: {
            sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
            score: { type: 'number' },
          },
          required: ['sentiment'],
        },
      },
      {
        role: 'fast',
        operation: 'workflow.sentiment',
        executionId: context.executionId,
        conversationId: context.conversationId,
      },
    );

    const score = clamp(Number(value.score ?? 0), -1, 1);
    return {
      output: { sentiment: value.sentiment, score },
      branch: value.sentiment,
      statePatch: { sentiment: value.sentiment, sentimentScore: score },
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        costUsd: estimateCostUsd(
          response.model,
          response.usage.promptTokens,
          response.usage.completionTokens,
        ),
        model: response.model,
      },
    };
  }

  /**
   * A full grounded answer: retrieve, generate, check guardrails, and hand off
   * when the answer is not confident or not grounded.
   */
  private async runAgentNode(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as {
      instructions?: string;
      question?: string;
      knowledgeBaseIds?: string[];
      guardrailPolicyId?: string;
      temperature?: number;
      topK?: number;
    };
    const question = interpolate(config.question ?? '{{ input.message }}', scope);

    const inputVerdict = await this.guardrails.checkInput(question, {
      policyId: config.guardrailPolicyId,
      conversationId: context.conversationId,
      executionId: context.executionId,
    });
    if (inputVerdict.blocked) {
      return {
        output: { blocked: true, reason: inputVerdict.reason },
        branch: 'blocked',
        statePatch: { blocked: true },
      };
    }
    if (inputVerdict.handoff) {
      return {
        output: { handoff: true, reason: inputVerdict.reason },
        branch: 'handoff',
        statePatch: { handoffReason: inputVerdict.reason },
      };
    }

    const readable = await this.knowledge.readableBaseIds();
    const scopeIds = await this.guardrails.scopeRetrieval(
      config.knowledgeBaseIds ?? readable,
      readable,
    );
    const hits = await this.rag.retrieve(inputVerdict.text, {
      knowledgeBaseIds: scopeIds,
      topK: config.topK ?? 6,
      conversationId: context.conversationId,
      executionId: context.executionId,
    });
    const { context: retrieved, citations } = this.rag.buildContext(hits);

    const response = await this.gateway.complete(
      {
        messages: [
          {
            role: 'system',
            content: `${config.instructions ?? 'You are a helpful customer support agent. Answer only from the context provided, and say so when the context does not contain the answer.'}\n\n<context>\n${retrieved}\n</context>`,
          },
          { role: 'user', content: inputVerdict.text },
        ],
        temperature: config.temperature ?? 0.3,
      },
      {
        role: 'chat',
        operation: 'workflow.agent',
        executionId: context.executionId,
        agentId: context.agentId,
        conversationId: context.conversationId,
      },
    );

    const groundedness = this.rag.groundedness(response.content, hits);
    const outputVerdict = await this.guardrails.checkOutput(response.content, {
      policyId: config.guardrailPolicyId,
      conversationId: context.conversationId,
      executionId: context.executionId,
      groundedness,
      confidence: response.confidence,
    });

    const usage = {
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      costUsd: estimateCostUsd(
        response.model,
        response.usage.promptTokens,
        response.usage.completionTokens,
      ),
      model: response.model,
    };

    if (outputVerdict.blocked || outputVerdict.handoff) {
      return {
        output: {
          handoff: true,
          reason: outputVerdict.reason,
          confidence: response.confidence,
          groundedness: groundedness.score,
        },
        branch: outputVerdict.blocked ? 'blocked' : 'handoff',
        statePatch: { handoffReason: outputVerdict.reason },
        usage,
      };
    }

    return {
      output: {
        answer: outputVerdict.text,
        citations,
        confidence: response.confidence,
        groundedness: groundedness.score,
      },
      branch: 'answered',
      statePatch: { answer: outputVerdict.text, citations, confidence: response.confidence },
      usage,
    };
  }

  // ── Knowledge nodes ────────────────────────────────────────────────────────

  private async runKnowledge(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as { query?: string; knowledgeBaseIds?: string[]; topK?: number };
    const query = interpolate(config.query ?? '{{ input.message }}', scope);

    const readable = await this.knowledge.readableBaseIds();
    const scopeIds = config.knowledgeBaseIds?.length
      ? config.knowledgeBaseIds.filter((id) => readable.includes(id))
      : readable;

    const hits = await this.rag.retrieve(query, {
      knowledgeBaseIds: scopeIds,
      topK: config.topK ?? 6,
      conversationId: context.conversationId,
      executionId: context.executionId,
    });
    const { context: retrieved, citations } = this.rag.buildContext(hits);

    return {
      output: {
        hits: hits.length,
        citations,
        passages: hits.map((hit) => ({ title: hit.title, content: hit.content, score: hit.score })),
      },
      branch: hits.length ? 'found' : 'empty',
      statePatch: { context: retrieved, citations },
    };
  }

  // ── Logic nodes ────────────────────────────────────────────────────────────

  private runCondition(node: WorkflowNode, scope: Record<string, unknown>): NodeExecutionResult {
    const config = node.config as { expression?: string };
    try {
      const result = evaluateCondition(config.expression ?? '', scope);
      return { output: { result }, branch: result ? 'true' : 'false' };
    } catch (error) {
      return { output: null, error: `Condition failed to evaluate: ${(error as Error).message}` };
    }
  }

  private runSwitch(node: WorkflowNode, scope: Record<string, unknown>): NodeExecutionResult {
    const config = node.config as {
      path?: string;
      cases?: { value: string; branch: string }[];
      default?: string;
    };
    const value = config.path ? resolvePath(config.path, scope) : undefined;
    const match = config.cases?.find(
      (entry) => String(entry.value).toLowerCase() === String(value ?? '').toLowerCase(),
    );
    return {
      output: { value, matched: match?.branch ?? config.default ?? 'default' },
      branch: match?.branch ?? config.default ?? 'default',
    };
  }

  private runSet(node: WorkflowNode, scope: Record<string, unknown>): NodeExecutionResult {
    const config = node.config as { variables?: Record<string, string> };
    const patch: Record<string, unknown> = {};
    for (const [key, template] of Object.entries(config.variables ?? {})) {
      patch[key] = typeof template === 'string' ? interpolate(template, scope) : template;
    }
    return { output: patch, statePatch: patch };
  }

  /** A delay suspends rather than sleeping, so it never holds a worker. */
  private runDelay(node: WorkflowNode, scope: Record<string, unknown>): NodeExecutionResult {
    const config = node.config as { seconds?: number; until?: string };
    const seconds = Number(config.seconds ?? 0);
    const resumeAfter = config.until
      ? new Date(interpolate(config.until, scope))
      : new Date(Date.now() + Math.max(1, seconds) * 1000);

    return {
      output: { resumeAfter: resumeAfter.toISOString() },
      suspend: { reason: 'delay', resumeAfter },
    };
  }

  /** Bounded iteration; the counter lives in execution state so it survives a restart. */
  private runLoop(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
  ): NodeExecutionResult {
    const config = node.config as { maxIterations?: number; condition?: string };
    const key = `__loop_${node.id}`;
    const iteration = Number((context.state[key] as number) ?? 0) + 1;
    const max = Math.min(Number(config.maxIterations ?? 10), 50);

    const shouldContinue =
      iteration <= max && (!config.condition || evaluateCondition(config.condition, scope));
    return {
      output: { iteration, continue: shouldContinue },
      branch: shouldContinue ? 'continue' : 'done',
      statePatch: { [key]: iteration },
    };
  }

  // ── Action nodes ───────────────────────────────────────────────────────────

  private async runSendMessage(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as { body?: string; conversationId?: string };
    const conversationId = config.conversationId ?? context.conversationId;
    if (!conversationId)
      return { output: null, error: 'There is no conversation to send a message to' };

    const body = interpolate(config.body ?? '{{ answer }}', scope).trim();
    if (!body) return { output: null, error: 'The message body is empty' };

    const message = await this.channels.sendReply({
      conversationId,
      body,
      authorType: 'ai_agent',
      authorId: context.agentId,
      citations: (scope.citations as unknown[]) ?? undefined,
    });
    return { output: { messageId: message.id, deliveryState: message.deliveryState } };
  }

  private async runCreateTicket(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as {
      subject?: string;
      description?: string;
      priority?: string;
      category?: string;
    };
    const payload = {
      subject: interpolate(config.subject ?? 'Follow-up required', scope),
      description: config.description ? interpolate(config.description, scope) : undefined,
      priority: config.priority,
      category: config.category,
    };

    const ticket = context.conversationId
      ? await this.tickets.createFromConversation(context.conversationId, payload as never)
      : await this.tickets.create(payload as never);
    return {
      output: { ticketId: ticket.id, reference: ticket.reference },
      statePatch: { ticketId: ticket.id },
    };
  }

  private async runUpdateTicket(
    node: WorkflowNode,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as {
      ticketId?: string;
      status?: string;
      priority?: string;
      category?: string;
    };
    const ticketId = config.ticketId
      ? interpolate(config.ticketId, scope)
      : (scope.ticketId as string | undefined);
    if (!ticketId) return { output: null, error: 'No ticket id was provided' };

    const ticket = await this.tickets.update(ticketId, {
      status: config.status,
      priority: config.priority,
      category: config.category,
    } as never);
    return { output: { ticketId: ticket.id, status: ticket.status } };
  }

  private async runUpdateCustomer(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as { customerId?: string; fields?: Record<string, string> };
    let customerId = config.customerId ? interpolate(config.customerId, scope) : undefined;

    if (!customerId && context.conversationId) {
      const conversation = await this.conversations.get(context.conversationId);
      customerId = conversation.customerId ?? undefined;
    }
    if (!customerId)
      return { output: null, error: 'No customer is associated with this execution' };

    const patch: Record<string, unknown> = {};
    for (const [key, template] of Object.entries(config.fields ?? {})) {
      patch[key] = typeof template === 'string' ? interpolate(template, scope) : template;
    }
    const customer = await this.customers.update(customerId, patch as never);
    return { output: { customerId: customer.id } };
  }

  /** An HTTP action, subject to the same egress control as a custom tool. */
  private async runHttp(
    node: WorkflowNode,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    };
    const url = interpolate(config.url ?? '', scope);

    const egress = isEgressAllowed(url);
    if (!egress.allowed)
      return { output: null, error: `The request was refused: ${egress.reason}` };

    const method = (config.method ?? 'POST').toUpperCase();
    const body = config.body ? interpolate(JSON.stringify(config.body), scope) : undefined;

    try {
      const response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...(config.headers ?? {}) },
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        signal: AbortSignal.timeout(Math.min(config.timeoutMs ?? 10_000, 30_000)),
        redirect: 'error',
      });
      const text = (await response.text()).slice(0, 100_000);
      let payload: unknown = text;
      try {
        payload = JSON.parse(text);
      } catch {
        // Not JSON; the text is still the result.
      }
      return {
        output: { status: response.status, body: payload },
        branch: response.ok ? 'success' : 'error',
        ...(response.ok ? {} : { error: `The request returned ${response.status}` }),
      };
    } catch (error) {
      return { output: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async runTool(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as {
      toolKey?: string;
      arguments?: Record<string, unknown>;
      declaredTools?: string[];
    };
    if (!config.toolKey) return { output: null, error: 'No tool was selected for this node' };

    const tool = await this.tools.findByKey(config.toolKey);
    if (!tool) return { output: null, error: `Unknown tool "${config.toolKey}"` };

    const verdict = await this.guardrails.checkToolCall(
      { key: config.toolKey, url: tool.url, requiresApproval: tool.requiresApproval },
      {
        conversationId: context.conversationId,
        executionId: context.executionId,
        declaredTools: config.declaredTools,
      },
    );
    if (verdict.blocked)
      return { output: null, error: verdict.reason ?? 'The tool call was blocked' };
    if (verdict.handoff) {
      return {
        output: { pendingApproval: true, tool: config.toolKey },
        suspend: { reason: 'tool_approval' },
      };
    }

    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config.arguments ?? {})) {
      args[key] = typeof value === 'string' ? interpolate(value, scope) : value;
    }

    const result = await this.tools.invoke(config.toolKey, args, {
      conversationId: context.conversationId,
      executionId: context.executionId,
      stepId: context.stepId,
      agentId: context.agentId,
    });

    return {
      output: result.output,
      branch: result.ok ? 'success' : 'error',
      ...(result.ok ? {} : { error: result.error }),
    };
  }

  // ── Human nodes ────────────────────────────────────────────────────────────

  /**
   * Hand the conversation to a person. The execution ends here — from this
   * point a human owns the interaction, and the workflow must not keep acting.
   */
  private async runHandoff(
    node: WorkflowNode,
    context: NodeRuntimeContext,
    scope: Record<string, unknown>,
  ): Promise<NodeExecutionResult> {
    const config = node.config as {
      reason?: string;
      queueId?: string;
      teamId?: string;
      userId?: string;
      summary?: string;
      priority?: string;
    };
    const reason = interpolate(
      config.reason ?? (scope.handoffReason as string) ?? 'The AI agent requested human assistance',
      scope,
    );

    // Running an agent outside a conversation is a legitimate test path. The
    // decision to hand off is still the correct outcome and is reported as
    // such — it is not an execution failure.
    if (!context.conversationId) {
      return {
        output: {
          handoff: true,
          reason,
          applied: false,
          note: 'No conversation is attached, so no transfer was performed',
        },
        terminal: true,
      };
    }

    if (config.userId || config.teamId || config.queueId) {
      await this.conversations.transfer(
        context.conversationId,
        { userId: config.userId, teamId: config.teamId, queueId: config.queueId },
        reason,
      );
    } else {
      await this.conversations.assign(context.conversationId, null, { reason });
    }

    // Record why the AI stepped back, so the workspace can show it beside the
    // conversation rather than only in the event log.
    await this.conversations.setHandoffReason(context.conversationId, reason);

    // An AI-written summary is what makes a handoff useful rather than a dump.
    const summary = config.summary
      ? interpolate(config.summary, scope)
      : (scope.answer as string | undefined);
    await this.conversations.addInternalNote(
      context.conversationId,
      summary ? `AI handoff — ${reason}\n\n${summary}` : `AI handoff — ${reason}`,
    );

    await this.conversations.recordEvent(context.conversationId, 'ai_handoff', {
      reason,
      nodeId: node.id,
    });

    if (node.type === 'human.escalate' && config.priority) {
      await this.conversations.update(context.conversationId, { priority: config.priority });
    }

    this.logger.info('Conversation handed to a human', {
      conversationId: context.conversationId,
      reason,
    });
    return { output: { handoff: true, reason }, terminal: true };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0;
}
