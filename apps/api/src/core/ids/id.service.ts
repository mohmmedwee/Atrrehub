import { ulid } from 'ulid';

/**
 * Prefixed ULIDs. Sortable by creation time, opaque to clients, and
 * self-describing when they turn up in a log line or a support ticket.
 */
export const ID_PREFIXES = {
  organization: 'org',
  workspace: 'wks',
  subscription: 'sub',
  user: 'usr',
  membership: 'mem',
  role: 'rol',
  session: 'ses',
  token: 'tok',
  apiKey: 'akr',
  audit: 'aud',
  team: 'tem',
  teamMember: 'tmb',
  queue: 'que',
  businessHours: 'bhr',
  holiday: 'hol',
  customField: 'cfd',
  tag: 'tag',
  savedReply: 'rep',
  customer: 'cus',
  contactMethod: 'cmt',
  note: 'not',
  activity: 'act',
  aiContext: 'ctx',
  segment: 'seg',
  channelAccount: 'cha',
  conversation: 'cnv',
  message: 'msg',
  attachment: 'att',
  participant: 'ptp',
  conversationEvent: 'cev',
  ticket: 'tkt',
  comment: 'cmn',
  history: 'his',
  template: 'tpl',
  slaPolicy: 'slp',
  slaTarget: 'slt',
  slaClock: 'slc',
  routingRule: 'rtr',
  cursor: 'cur',
  knowledgeBase: 'kb',
  category: 'cat',
  article: 'art',
  articleVersion: 'arv',
  source: 'src',
  document: 'doc',
  chunk: 'chk',
  retrievalLog: 'rtl',
  modelRoute: 'mrt',
  aiUsage: 'usg',
  governance: 'gov',
  agent: 'agt',
  agentVersion: 'agv',
  workflow: 'wfl',
  workflowVersion: 'wfv',
  execution: 'exe',
  step: 'stp',
  tool: 'tol',
  invocation: 'inv',
  memory: 'mry',
  guardrail: 'grd',
  guardrailEvent: 'gre',
  automation: 'atm',
  automationRun: 'atr',
  qcTemplate: 'qct',
  qcCriterion: 'qcc',
  qcEvaluation: 'qce',
  qcScore: 'qcs',
  qcDispute: 'qcd',
  signal: 'sig',
  intelligence: 'itl',
  dataset: 'dst',
  evalCase: 'evc',
  evalRun: 'evr',
  evalResult: 'evl',
  metric: 'mtr',
  report: 'rpt',
  notificationRule: 'nfr',
  notification: 'ntf',
  usageRecord: 'urc',
  integration: 'itg',
  webhook: 'whk',
  delivery: 'dlv',
  outbox: 'evt',
  idempotency: 'idm',
  requestLog: 'rql',
  sso: 'sso',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** Generate a prefixed ULID, e.g. `cus_01J8XK...`. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

/** True when `id` is a well-formed identifier of the given kind. */
export function isId(kind: IdKind, id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(`${ID_PREFIXES[kind]}_`) && id.length > 4;
}

/** A short, human-quotable reference such as `C-9F2K4Q` for conversations. */
export function newReference(prefix: string): string {
  return `${prefix}-${ulid().slice(-6)}`;
}
