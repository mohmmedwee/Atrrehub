import { Prisma } from '@prisma/client';
import { RequestContextStore } from '../context/request-context';
import { AppError } from '../errors/app-error';

/**
 * Models that are not owned by a tenant. Everything else must carry
 * `organizationId` and is scoped automatically.
 */
const GLOBAL_MODELS = new Set([
  'User',
  'Session',
  'VerificationToken',
  'TeamMember',
  'TicketCounter',
  'RoundRobinCursor',
  'ApiRequestLog',
]);

/** Read/write operations that accept a `where` clause we can constrain. */
const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
  'count',
  'aggregate',
  'groupBy',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'upsert']);

/** Models carrying an `organizationId` column, derived from the generated schema. */
const tenantModels = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'organizationId'))
    .map((model) => model.name),
);

export function isTenantModel(model: string | undefined): boolean {
  return !!model && tenantModels.has(model) && !GLOBAL_MODELS.has(model);
}

/**
 * Enforces tenant isolation at the query layer.
 *
 * Every query against a tenant-owned model is constrained to the organization in
 * the active request context, and every write is stamped with it. A query issued
 * with no tenant context fails loudly rather than silently reading across
 * tenants — the failure mode we care about is a missing scope, not a noisy error.
 *
 * Raw queries bypass this extension by construction; `$queryRaw` callers must
 * filter on `organization_id` themselves (see RagRepository for the pattern).
 */
export const tenantGuardExtension = Prisma.defineExtension({
  name: 'tenant-guard',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!isTenantModel(model)) return query(args);

        const context = RequestContextStore.get();
        if (context?.systemBypass) return query(args);

        const organizationId = context?.organizationId;
        if (!organizationId) {
          throw new AppError(
            'internal_error',
            `Tenant-scoped query on ${model}.${operation} was issued without an organization context`,
            { meta: { model, operation } },
          );
        }

        const next = (args ?? {}) as Record<string, any>;

        if (WHERE_OPERATIONS.has(operation)) {
          // `where` on update/delete/findUnique accepts non-unique filters
          // alongside the unique selector, so the constraint composes safely.
          next.where = { ...(next.where ?? {}), organizationId };
        }

        if (CREATE_OPERATIONS.has(operation)) {
          if (operation === 'createMany') {
            const data = next.data;
            next.data = Array.isArray(data)
              ? data.map((row: Record<string, unknown>) => ({ ...row, organizationId }))
              : { ...(data ?? {}), organizationId };
          } else if (operation === 'upsert') {
            next.create = { ...(next.create ?? {}), organizationId };
          } else {
            next.data = { ...(next.data ?? {}), organizationId };
          }
        }

        return query(next);
      },
    },
  },
});
