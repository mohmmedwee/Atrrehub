/**
 * What "erase this person" actually means, table by table.
 *
 * Kept as data rather than as procedural code so that the answer to "what
 * happens to a customer's messages when they invoke their right to erasure" is
 * a table somebody can read, argue with, and hand to a regulator — rather than
 * something to be reconstructed by tracing a service method.
 */

export type ErasureAction =
  /** The row exists only because the person did; it goes. */
  | 'delete'
  /** The row has operational meaning without them; their data is removed from it. */
  | 'redact'
  /** A stored object outside the database — the file is deleted, then the row. */
  | 'delete_with_object';

export interface ErasureStep {
  /** The Prisma model, for the audit record and the dry run. */
  model: string;
  action: ErasureAction;
  /** Fields overwritten when the action is `redact`. */
  fields?: string[];
  /** Why, in one line. This is the part a data protection officer reads. */
  because: string;
}

/**
 * The tombstone left where content used to be.
 *
 * Deliberately not an empty string: a blank message body is indistinguishable
 * from a bug, and an agent scrolling a conversation needs to see that something
 * was removed on purpose rather than lost.
 */
export const ERASED = '[erased at the request of the data subject]';

/**
 * Redact rather than delete wherever the row carries meaning of its own.
 *
 * Deleting every conversation a person ever had would take the agent's replies,
 * the SLA record, the quality evaluations and the volume statistics with it —
 * none of which are the person's personal data, and some of which the business
 * is separately required to keep. Erasure removes the person from the record;
 * it does not rewrite the history of the business.
 */
export const ERASURE_PLAN: ErasureStep[] = [
  {
    model: 'memoryEntry',
    action: 'delete',
    because: 'Everything the AI remembered about them, and nothing else.',
  },
  {
    model: 'customerAiContext',
    action: 'delete',
    because: 'A generated profile of the person; meaningless once they are gone.',
  },
  {
    model: 'customerNote',
    action: 'delete',
    because: 'Agents’ notes are about the person and nothing else.',
  },
  {
    model: 'customerActivity',
    action: 'delete',
    because: 'A timeline of one person’s interactions.',
  },
  {
    model: 'contactMethod',
    action: 'delete',
    because: 'Email addresses and phone numbers are the identifiers themselves.',
  },
  {
    model: 'attachment',
    action: 'delete_with_object',
    because: 'Files they sent may contain anything; the stored object goes too.',
  },
  {
    model: 'callRecording',
    action: 'delete_with_object',
    because: 'A recording is their voice — biometric data under GDPR Article 9.',
  },
  {
    model: 'message',
    action: 'redact',
    fields: ['body', 'bodyHtml', 'redactedBody', 'authorName', 'externalId', 'metadata'],
    because:
      'The conversation stays so the SLA and quality record survive, but every word they wrote goes.',
  },
  {
    model: 'participant',
    action: 'redact',
    fields: ['displayName'],
    because: 'The participant row proves someone was there; their name need not.',
  },
  {
    model: 'callEvent',
    action: 'redact',
    fields: ['payload'],
    because: 'DTMF digits and IVR paths can carry account and card numbers.',
  },
  {
    model: 'call',
    action: 'redact',
    fields: ['fromNumber', 'toNumber', 'digits', 'customerId'],
    because: 'The call record stays for reporting; the numbers dialled do not.',
  },
  {
    model: 'conversation',
    action: 'redact',
    fields: ['subject', 'customerId', 'externalId', 'threadKey', 'attributes', 'metadata'],
    because: 'A subject line is often the whole complaint, and a thread key is an address.',
  },
  {
    model: 'ticket',
    action: 'redact',
    fields: ['subject', 'description', 'customerId', 'customFields'],
    because: 'The ticket’s number and timings are business records; its text is theirs.',
  },
  {
    model: 'customer',
    action: 'delete',
    because: 'Last, so that everything above can still be found by following it.',
  },
];

/**
 * Order matters and is not alphabetical: the customer row is the only way to
 * find most of the rest, so it is deleted last. A plan that removed it first
 * would leave orphaned transcripts nobody could ever locate again — which is
 * worse than not erasing at all, because it looks like erasure.
 */
export function assertPlanIsOrdered(plan: ErasureStep[] = ERASURE_PLAN): void {
  const customerIndex = plan.findIndex((step) => step.model === 'customer');
  if (customerIndex !== plan.length - 1) {
    throw new Error('The customer row must be erased last, or the rest becomes unreachable');
  }
}

/** Fields the export includes for each model, so an export is auditable too. */
export const EXPORT_SECTIONS = [
  'customer',
  'contactMethods',
  'notes',
  'activities',
  'aiContext',
  'conversations',
  'messages',
  'tickets',
  'calls',
  'memory',
] as const;

export type ExportSection = (typeof EXPORT_SECTIONS)[number];
