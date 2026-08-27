import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { DomainEvent } from '../../core/events/domain-events';
import { EventBus } from '../../core/events/event-bus.service';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { ConversationsService } from '../conversations/conversations.service';
import { CustomersService } from '../customers/customers.service';
import { isEgressAllowed } from '../guardrails/detectors';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { RagService } from '../rag/rag.service';
import { TicketsService } from '../tickets/tickets.service';
import type { ToolSchema } from '../ai/provider';

export interface ToolInvocationResult {
  ok: boolean;
  output: unknown;
  statusCode?: number;
  error?: string;
  durationMs: number;
}

export interface ToolExecutionContext {
  conversationId?: string;
  customerId?: string;
  executionId?: string;
  stepId?: string;
  agentId?: string;
}

/**
 * The tools an AI agent can call.
 *
 * Built-in tools reach the platform's own services directly, so they are fast
 * and correctly tenant-scoped. Custom tools are HTTP calls whose endpoint has
 * already cleared egress control — they run with a hard timeout and a response
 * size cap, because an agent must never be able to hang a conversation or
 * exhaust memory on a hostile response.
 */
@Injectable()
export class ToolsService {
  private readonly builtins: Record<
    string,
    { schema: ToolSchema; run: (args: any, context: ToolExecutionContext) => Promise<unknown> }
  >;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
    private readonly events: EventBus,
    private readonly logger: AppLogger,
    private readonly customers: CustomersService,
    private readonly conversations: ConversationsService,
    private readonly tickets: TicketsService,
    private readonly knowledge: KnowledgeService,
    private readonly rag: RagService,
  ) {
    this.builtins = this.defineBuiltins();
  }

  // ── Built-in tools ─────────────────────────────────────────────────────────

  private defineBuiltins() {
    return {
      customer_lookup: {
        schema: {
          name: 'customer_lookup',
          description:
            'Find a customer by email address, phone number or name, and return their profile and recent history.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Email address, phone number, or name to search for',
              },
            },
            required: ['query'],
          },
        },
        run: async (args: { query: string }) => {
          const results = await this.customers.search({ q: args.query, limit: 5 });
          return {
            found: results.data.length,
            customers: results.data.map((customer) => ({
              id: customer.id,
              name: customer.displayName,
              company: customer.company,
              tier: customer.tier,
              contact: customer.contactMethods?.[0]?.value,
            })),
          };
        },
      },

      knowledge_search: {
        schema: {
          name: 'knowledge_search',
          description:
            'Search the organization knowledge base for policies, procedures and product information.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to look up' },
              topK: { type: 'integer', description: 'How many passages to return (default 5)' },
            },
            required: ['query'],
          },
        },
        run: async (args: { query: string; topK?: number }) => {
          const scope = await this.knowledge.readableBaseIds();
          const hits = await this.rag.retrieve(args.query, {
            knowledgeBaseIds: scope,
            topK: args.topK ?? 5,
          });
          return {
            found: hits.length,
            passages: hits.map((hit) => ({
              title: hit.title,
              heading: hit.heading,
              content: hit.content,
              score: hit.score,
            })),
          };
        },
      },

      create_ticket: {
        schema: {
          name: 'create_ticket',
          description:
            'Open a support ticket for work that cannot be resolved in the conversation.',
          parameters: {
            type: 'object',
            properties: {
              subject: { type: 'string', description: 'Short summary of the issue' },
              description: { type: 'string', description: 'Full description of the issue' },
              priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent', 'critical'] },
              category: { type: 'string' },
            },
            required: ['subject'],
          },
        },
        run: async (
          args: { subject: string; description?: string; priority?: string; category?: string },
          context: ToolExecutionContext,
        ) => {
          const ticket = context.conversationId
            ? await this.tickets.createFromConversation(context.conversationId, args as never)
            : await this.tickets.create({ ...args, customerId: context.customerId } as never);
          return { ticketId: ticket.id, reference: ticket.reference, status: ticket.status };
        },
      },

      update_ticket: {
        schema: {
          name: 'update_ticket',
          description: 'Update the status, priority or category of an existing ticket.',
          parameters: {
            type: 'object',
            properties: {
              ticketId: { type: 'string' },
              status: {
                type: 'string',
                enum: ['open', 'pending', 'on_hold', 'resolved', 'closed'],
              },
              priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent', 'critical'] },
              category: { type: 'string' },
            },
            required: ['ticketId'],
          },
        },
        run: async (args: {
          ticketId: string;
          status?: string;
          priority?: string;
          category?: string;
        }) => {
          const { ticketId, ...patch } = args;
          const ticket = await this.tickets.update(ticketId, patch as never);
          return { ticketId: ticket.id, status: ticket.status, priority: ticket.priority };
        },
      },

      update_customer: {
        schema: {
          name: 'update_customer',
          description:
            'Update a customer profile with information gathered during the conversation.',
          parameters: {
            type: 'object',
            properties: {
              customerId: { type: 'string' },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              company: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        run: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
          const customerId = (args.customerId as string) ?? context.customerId;
          if (!customerId)
            throw AppError.badRequest('No customer is associated with this conversation');
          const { customerId: _ignored, ...patch } = args;
          const customer = await this.customers.update(customerId, patch as never);
          return { customerId: customer.id, name: customer.displayName };
        },
      },

      send_message: {
        schema: {
          name: 'send_message',
          description: 'Send a message to the customer in the current conversation.',
          parameters: {
            type: 'object',
            properties: { body: { type: 'string', description: 'The message to send' } },
            required: ['body'],
          },
        },
        run: async (args: { body: string }, context: ToolExecutionContext) => {
          if (!context.conversationId)
            throw AppError.badRequest('There is no conversation to send a message to');
          const message = await this.conversations.addMessage({
            conversationId: context.conversationId,
            body: args.body,
            direction: 'outbound',
            authorType: 'ai_agent',
            authorId: context.agentId,
          });
          return { messageId: message.id, delivered: true };
        },
      },

      conversation_history: {
        schema: {
          name: 'conversation_history',
          description: 'Read the recent messages of the current conversation.',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'integer', description: 'How many messages to read (default 20)' },
            },
          },
        },
        run: async (args: { limit?: number }, context: ToolExecutionContext) => {
          if (!context.conversationId) return { messages: [] };
          const page = await this.conversations.listMessages(context.conversationId, {
            limit: Math.min(args.limit ?? 20, 100),
          });
          return {
            messages: page.data.map((message) => ({
              direction: message.direction,
              author: message.authorType,
              body: message.body,
              at: message.createdAt,
            })),
          };
        },
      },
    };
  }

  builtinSchemas(): ToolSchema[] {
    return Object.values(this.builtins).map((tool) => tool.schema);
  }

  // ── Definitions ────────────────────────────────────────────────────────────

  async list() {
    const custom = await this.prisma.db.toolDefinition.findMany({
      where: {},
      orderBy: { name: 'asc' },
    });
    return [
      ...Object.entries(this.builtins).map(([key, tool]) => ({
        id: `builtin:${key}`,
        key,
        name: tool.schema.name,
        description: tool.schema.description,
        kind: 'builtin' as const,
        inputSchema: tool.schema.parameters,
        isActive: true,
      })),
      ...custom.map(({ auth: _auth, ...tool }) => tool),
    ];
  }

  async create(input: {
    key: string;
    name: string;
    description: string;
    method?: string;
    url: string;
    headers?: Record<string, string>;
    auth?: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    timeoutMs?: number;
    requiresApproval?: boolean;
  }) {
    if (this.builtins[input.key]) throw AppError.conflict(`"${input.key}" is a built-in tool name`);

    // Refuse a tool that could never legally be called, rather than failing later.
    const egress = isEgressAllowed(input.url);
    if (!egress.allowed)
      throw AppError.badRequest(`The tool endpoint was refused: ${egress.reason}`);

    const principal = RequestContextStore.principal();
    return this.prisma.db.toolDefinition.create({
      data: {
        id: newId('tool'),
        key: input.key,
        name: input.name,
        description: input.description,
        kind: 'http',
        method: input.method ?? 'POST',
        url: input.url,
        headers: (input.headers ?? {}) as Prisma.InputJsonValue,
        auth: this.crypto.encryptObject(input.auth ?? {}) as Prisma.InputJsonValue,
        inputSchema: (input.inputSchema ?? {
          type: 'object',
          properties: {},
        }) as Prisma.InputJsonValue,
        outputSchema: (input.outputSchema ?? {}) as Prisma.InputJsonValue,
        timeoutMs: Math.min(input.timeoutMs ?? 10_000, 30_000),
        requiresApproval: input.requiresApproval ?? false,
        createdById: principal?.id ?? null,
      } as never,
    });
  }

  async update(toolId: string, patch: Record<string, unknown>) {
    if (typeof patch.url === 'string') {
      const egress = isEgressAllowed(patch.url);
      if (!egress.allowed)
        throw AppError.badRequest(`The tool endpoint was refused: ${egress.reason}`);
    }
    if (patch.auth) patch.auth = this.crypto.encryptObject(patch.auth as Record<string, unknown>);
    return this.prisma.db.toolDefinition.update({ where: { id: toolId }, data: patch as never });
  }

  async delete(toolId: string) {
    await this.prisma.db.toolDefinition.delete({ where: { id: toolId } });
  }

  /** Resolve the tool schemas an agent version has declared. */
  async schemasFor(toolKeys: string[]): Promise<ToolSchema[]> {
    if (!toolKeys.length) return [];
    const schemas: ToolSchema[] = [];

    for (const key of toolKeys) {
      const builtin = this.builtins[key];
      if (builtin) {
        schemas.push(builtin.schema);
        continue;
      }
      const custom = await this.prisma.db.toolDefinition.findFirst({
        where: { key, isActive: true },
      });
      if (custom) {
        schemas.push({
          name: custom.key,
          description: custom.description,
          parameters: (custom.inputSchema ?? { type: 'object', properties: {} }) as Record<
            string,
            unknown
          >,
        });
      }
    }
    return schemas;
  }

  async findByKey(key: string) {
    const builtin = this.builtins[key];
    if (builtin) {
      return {
        id: `builtin:${key}`,
        key,
        kind: 'builtin' as const,
        url: null,
        requiresApproval: false,
        isActive: true,
      };
    }
    return this.prisma.db.toolDefinition.findFirst({ where: { key } });
  }

  // ── Invocation ─────────────────────────────────────────────────────────────

  async invoke(
    key: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolInvocationResult> {
    const started = Date.now();
    await this.assertPermittedByPolicy(key);

    const builtin = this.builtins[key];
    if (builtin) {
      try {
        const output = await builtin.run(args, context);
        const result = { ok: true, output, durationMs: Date.now() - started };
        await this.recordInvocation(key, null, args, result, context);
        return result;
      } catch (error) {
        const result = {
          ok: false,
          output: null,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
        };
        await this.recordInvocation(key, null, args, result, context);
        return result;
      }
    }

    const tool = await this.prisma.db.toolDefinition.findFirst({ where: { key, isActive: true } });
    if (!tool) throw AppError.notFound('Tool', key);

    const result = await this.invokeHttp(tool, args);
    await this.recordInvocation(key, tool.id, args, result, context);
    return result;
  }

  /**
   * Refuse a tool the tenant's governance policy does not list.
   *
   * The allow-list on the policy was stored and read by nothing, so a tenant
   * who restricted their agents to two tools still had every tool available.
   * An empty list means no restriction — it is the value every existing tenant
   * has, and treating it as "nothing is allowed" would disable the platform.
   *
   * Read through the same cache key the gateway uses, so a policy change
   * invalidates one entry rather than several that disagree in between.
   */
  private async assertPermittedByPolicy(key: string): Promise<void> {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return;

    const policy = await this.redis.remember(
      this.redis.key(organizationId, 'governance'),
      300,
      async () => this.prisma.raw.governancePolicy.findUnique({ where: { organizationId } }),
    );
    if (!policy?.allowedTools.length) return;
    if (!policy.allowedTools.includes(key)) {
      throw AppError.policyBlocked(
        'ai_governance',
        `Your organization’s policy does not permit the tool ${key}`,
      );
    }
  }

  /** Call a custom HTTP tool with a hard timeout and a response size cap. */
  private async invokeHttp(
    tool: {
      url: string | null;
      method: string;
      headers: unknown;
      auth: unknown;
      timeoutMs: number;
    },
    args: Record<string, unknown>,
  ): Promise<ToolInvocationResult> {
    const started = Date.now();
    if (!tool.url)
      return {
        ok: false,
        output: null,
        error: 'The tool has no endpoint configured',
        durationMs: 0,
      };

    const auth = this.crypto.decryptObject((tool.auth ?? {}) as Record<string, unknown>);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'Atrrehub-Agent/1.0',
      ...((tool.headers ?? {}) as Record<string, string>),
    };

    switch (auth.type) {
      case 'bearer':
        headers.authorization = `Bearer ${auth.token}`;
        break;
      case 'api_key':
        headers[(auth.header as string) ?? 'x-api-key'] = String(auth.key);
        break;
      case 'basic':
        headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
        break;
      default:
        break;
    }

    // GET carries arguments in the query string; everything else in the body.
    const isBodyless = ['GET', 'HEAD'].includes(tool.method.toUpperCase());
    let url = tool.url;
    if (isBodyless) {
      const parsed = new URL(tool.url);
      for (const [key, value] of Object.entries(args)) {
        parsed.searchParams.set(
          key,
          typeof value === 'object' ? JSON.stringify(value) : String(value),
        );
      }
      url = parsed.toString();
    }

    try {
      const response = await fetch(url, {
        method: tool.method,
        headers,
        body: isBodyless ? undefined : JSON.stringify(args),
        signal: AbortSignal.timeout(Math.min(tool.timeoutMs, 30_000)),
        redirect: 'error',
      });

      // Cap the response so a hostile endpoint cannot exhaust memory.
      const text = (await response.text()).slice(0, 100_000);
      let output: unknown = text;
      try {
        output = JSON.parse(text);
      } catch {
        // Not JSON; the raw text is still useful to the model.
      }

      return {
        ok: response.ok,
        output,
        statusCode: response.status,
        error: response.ok ? undefined : `The tool returned ${response.status}`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        output: null,
        error:
          message.includes('abort') || message.includes('timeout') ? 'The tool timed out' : message,
        durationMs: Date.now() - started,
      };
    }
  }

  private async recordInvocation(
    key: string,
    toolId: string | null,
    input: Record<string, unknown>,
    result: ToolInvocationResult,
    context: ToolExecutionContext,
  ): Promise<void> {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId || !toolId) {
      // Built-in calls are still worth an event even without a definition row.
      await this.events
        .publish(
          DomainEvent.ToolInvoked,
          { type: 'tool', id: key },
          {
            toolId: key,
            executionId: context.executionId,
            status: result.ok ? 'succeeded' : 'failed',
            durationMs: result.durationMs,
          },
        )
        .catch(() => undefined);
      return;
    }

    try {
      await this.prisma.raw.toolInvocation.create({
        data: {
          id: newId('invocation'),
          organizationId,
          toolId,
          executionId: context.executionId ?? null,
          stepId: context.stepId ?? null,
          input: input as Prisma.InputJsonValue,
          output: (result.output ?? null) as Prisma.InputJsonValue,
          status: result.ok ? 'succeeded' : 'failed',
          statusCode: result.statusCode ?? null,
          error: result.error ?? null,
          durationMs: result.durationMs,
        },
      });
      await this.events.publish(
        DomainEvent.ToolInvoked,
        { type: 'tool', id: toolId },
        {
          toolId,
          executionId: context.executionId,
          status: result.ok ? 'succeeded' : 'failed',
          durationMs: result.durationMs,
        },
      );
    } catch (error) {
      this.logger.error('Failed to record a tool invocation', error, { key });
    }
  }

  async invocations(limit = 50) {
    return this.prisma.db.toolInvocation.findMany({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }
}
