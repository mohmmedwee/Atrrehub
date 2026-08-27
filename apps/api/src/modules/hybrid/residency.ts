import { detectPii } from '../guardrails/detectors';

/**
 * The data residency guard.
 *
 * A hybrid deployment exists for exactly one reason: the customer's data must
 * stay on the customer's infrastructure. Everything else — enrollment,
 * heartbeats, config distribution — is plumbing. This is the promise, so it is
 * enforced as a check on every payload rather than as a convention nobody can
 * audit.
 *
 * The design is allow-list, not deny-list. A deny-list of "fields that look
 * like content" fails silently the first time somebody adds a field nobody
 * thought of, and the failure mode is a customer's conversation body in
 * another jurisdiction. So a value leaves only if its key was declared
 * shippable, and everything else is refused whether or not it looks sensitive.
 */

export type ResidencyViolationKind =
  'undeclared_field' | 'pii_detected' | 'free_text' | 'too_deep' | 'too_large';

export interface ResidencyViolation {
  path: string;
  kind: ResidencyViolationKind;
  detail: string;
}

export interface ResidencyResult {
  allowed: boolean;
  violations: ResidencyViolation[];
}

/**
 * Every key a data plane may put on the wire to a control plane.
 *
 * Deliberately dull: counts, versions, timings and identifiers the control
 * plane issued itself. Adding to this list is the moment to ask whether the
 * new field could ever hold something a customer typed.
 */
export const SHIPPABLE_FIELDS = new Set([
  // Identity of the plane itself, never of a person.
  'dataPlaneId',
  'planeId',
  'region',
  'version',
  'schemaVersion',
  'contractVersion',
  'nodeCount',
  'environment',

  // Health.
  'status',
  'healthy',
  'degraded',
  'uptimeSeconds',
  'lastError',
  'lastErrorCode',
  'checkedAt',
  'reportedAt',
  'occurredAt',
  'periodStart',
  'periodEnd',

  // Aggregates. Counts and totals only — never a subject, never a body.
  'metric',
  'metrics',
  'value',
  'count',
  'quantity',
  'unit',
  'sum',
  'min',
  'max',
  'p50',
  'p95',
  'p99',
  'conversations',
  'messages',
  'tickets',
  'calls',
  'executions',
  'organizations',
  'users',
  'activeUsers',
  'storageBytes',
  'promptTokens',
  'completionTokens',
  'costUsd',
  'queueDepth',
  'errorRate',
  'latencyMs',

  // Structural.
  'organizationId',
  'workspaceId',
  'items',
  'entries',
  'data',
]);

/**
 * Keys that must never ship even if somebody adds them to the allow-list by
 * mistake. A belt to the allow-list's braces — cheap, and the one thing that
 * catches a careless edit to the list above in review.
 */
const FORBIDDEN_FIELDS = [
  /body/i,
  /subject/i,
  /content/i,
  /transcript/i,
  /message(text|body)?$/i,
  /email/i,
  /phone/i,
  /name/i,
  /address/i,
  /note/i,
  /comment/i,
  /answer/i,
  /question/i,
  /prompt/i,
  /summary/i,
  /reason/i,
  /attachment/i,
  /recording/i,
  /password/i,
  /token/i,
  /secret/i,
  /credential/i,
];

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 200;
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Whether this payload may cross the boundary.
 *
 * Reports every violation rather than the first, because an operator fixing a
 * telemetry payload wants the whole list, not one round-trip per field.
 */
export function checkResidency(payload: unknown): ResidencyResult {
  const violations: ResidencyViolation[] = [];

  const serialized = safeSerialize(payload);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    violations.push({
      path: '(root)',
      kind: 'too_large',
      detail: `${serialized.length} bytes exceeds the ${MAX_PAYLOAD_BYTES} byte ceiling`,
    });
  }

  walk(payload, '', 0, violations);
  return { allowed: violations.length === 0, violations };
}

function walk(value: unknown, path: string, depth: number, violations: ResidencyViolation[]): void {
  if (value === null || value === undefined) return;

  if (depth > MAX_DEPTH) {
    violations.push({
      path: path || '(root)',
      kind: 'too_deep',
      detail: `nested deeper than ${MAX_DEPTH} levels`,
    });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, depth + 1, violations));
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;

      if (FORBIDDEN_FIELDS.some((pattern) => pattern.test(key))) {
        violations.push({
          path: childPath,
          kind: 'undeclared_field',
          detail: `"${key}" names a field that may hold customer content`,
        });
        continue;
      }

      if (!SHIPPABLE_FIELDS.has(key)) {
        violations.push({
          path: childPath,
          kind: 'undeclared_field',
          detail: `"${key}" is not declared shippable`,
        });
        continue;
      }

      walk(child, childPath, depth + 1, violations);
    }
    return;
  }

  if (typeof value === 'string') {
    // A declared field can still be handed the wrong value, so every string
    // that ships is checked for the shapes personal data actually takes.
    const pii = detectPii(value);
    if (pii.length) {
      violations.push({
        path: path || '(root)',
        kind: 'pii_detected',
        detail: `looks like ${[...new Set(pii.map((match) => match.kind))].join(', ')}`,
      });
      return;
    }

    if (value.length > MAX_STRING_LENGTH) {
      violations.push({
        path: path || '(root)',
        kind: 'free_text',
        detail: `${value.length} characters is prose, not a label`,
      });
      return;
    }

    // Prose is the shape customer content arrives in when a field is misused.
    if (countWords(value) > 12) {
      violations.push({
        path: path || '(root)',
        kind: 'free_text',
        detail: 'reads as a sentence rather than an identifier or a label',
      });
    }
  }
}

/**
 * Strip a payload down to what may legitimately ship.
 *
 * Offered so a caller can send *something* rather than nothing when one field
 * is wrong — a heartbeat that fails entirely because a new metric was named
 * badly is a monitoring outage caused by a monitoring bug.
 */
export function redactForTransit(payload: unknown): unknown {
  if (payload === null || payload === undefined) return payload;
  if (Array.isArray(payload)) return payload.map(redactForTransit);

  if (typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (FORBIDDEN_FIELDS.some((pattern) => pattern.test(key))) continue;
      if (!SHIPPABLE_FIELDS.has(key)) continue;

      const cleaned = redactForTransit(value);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }

  if (typeof payload === 'string') {
    if (detectPii(payload).length) return undefined;
    if (payload.length > MAX_STRING_LENGTH || countWords(payload) > 12) return undefined;
  }

  return payload;
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
