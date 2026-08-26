import { AsyncLocalStorage } from 'node:async_hooks';

export type PrincipalType = 'user' | 'api_key' | 'widget' | 'system' | 'worker';

export interface Principal {
  type: PrincipalType;
  id: string;
  /** Display label used in audit records. */
  label?: string;
  permissions: string[];
  isOwner?: boolean;
  /** Workspaces the principal is pinned to; empty means every workspace. */
  workspaceIds?: string[];
  /** Teams the principal belongs to, used for scoped reads. */
  teamIds?: string[];
  roleKey?: string;
}

export interface RequestContext {
  requestId: string;
  organizationId?: string;
  workspaceId?: string;
  principal?: Principal;
  ipAddress?: string;
  userAgent?: string;
  startedAt: number;
  /** Set when the caller is deliberately operating across tenants (migrations, cron). */
  systemBypass?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContextStore = {
  run<T>(context: RequestContext, fn: () => T): T {
    return storage.run(context, fn);
  },

  get(): RequestContext | undefined {
    return storage.getStore();
  },

  /** The current tenant, or undefined outside a request (workers set it explicitly). */
  organizationId(): string | undefined {
    return storage.getStore()?.organizationId;
  },

  workspaceId(): string | undefined {
    return storage.getStore()?.workspaceId;
  },

  principal(): Principal | undefined {
    return storage.getStore()?.principal;
  },

  requestId(): string {
    return storage.getStore()?.requestId ?? 'no-request';
  },

  /** Mutate the active context — used once tenancy is resolved mid-request. */
  patch(patch: Partial<RequestContext>): void {
    const current = storage.getStore();
    if (current) Object.assign(current, patch);
  },

  /**
   * Run a block outside tenant scoping. Reserved for platform-level work such as
   * the outbox relay or cross-tenant maintenance jobs; never reachable from HTTP.
   *
   * The callback is awaited *inside* the scope. That matters because Prisma
   * promises are lazy: returning one unawaited would execute the query after
   * the context had already been torn down, silently losing the scope this
   * function exists to establish.
   */
  async runAsSystem<T>(fn: () => T | Promise<T>, organizationId?: string): Promise<T> {
    return storage.run(
      {
        requestId: `system-${Date.now().toString(36)}`,
        organizationId,
        systemBypass: !organizationId,
        startedAt: Date.now(),
        principal: { type: 'system', id: 'system', permissions: ['*'] },
      },
      async () => fn(),
    );
  },

  /**
   * Run a block inside an explicit context, awaiting within the scope for the
   * same reason as `runAsSystem`.
   */
  async runAsync<T>(context: RequestContext, fn: () => T | Promise<T>): Promise<T> {
    return storage.run(context, async () => fn());
  },
};
