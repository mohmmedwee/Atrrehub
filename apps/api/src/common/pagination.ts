import { z } from 'zod';

/** Cursor pagination is the default: stable under concurrent writes. */
export const CursorQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export type CursorParams = z.infer<typeof CursorQuery>;

export interface Page<T> {
  data: T[];
  meta: { limit: number; cursor: string | null; total?: number };
}

/**
 * Fetch `limit + 1` rows, use the extra row purely to decide whether another
 * page exists, and return the last visible id as the next cursor.
 */
export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
  total?: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    meta: {
      limit,
      cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
      ...(total !== undefined ? { total } : {}),
    },
  };
}

/** Prisma arguments for a cursor page. */
export function cursorArgs(params: CursorParams) {
  return {
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  };
}

/** Parses `sort=-createdAt,name` into Prisma orderBy, restricted to an allow-list. */
export function parseSort<T extends string>(
  sort: string | undefined,
  allowed: readonly T[],
  fallback: Record<string, 'asc' | 'desc'> = { createdAt: 'desc' },
): Record<string, 'asc' | 'desc'>[] {
  if (!sort) return [fallback];
  const parsed = sort
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const desc = token.startsWith('-');
      const field = desc ? token.slice(1) : token;
      return allowed.includes(field as T)
        ? { [field]: desc ? ('desc' as const) : ('asc' as const) }
        : null;
    })
    .filter((entry): entry is Record<string, 'asc' | 'desc'> => entry !== null);
  return parsed.length ? parsed : [fallback];
}

/** Splits `open,pending` into a Prisma `in` filter, ignoring unknown values. */
export function csvFilter<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (!value) return undefined;
  const values = value
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is T => allowed.includes(v as T));
  return values.length ? values : undefined;
}
