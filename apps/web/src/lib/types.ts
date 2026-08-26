/** Shapes the UI reads. Mirrors the API contracts in docs/api/standards.md. */

export interface Page<T> {
  data: T[];
  meta: { limit: number; cursor: string | null; total?: number };
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; firstName: string; lastName: string; mfaEnabled: boolean };
  organization: { id: string; name: string; slug: string };
  role: string;
  permissions: string[];
}

export interface Me {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    presence: string;
    locale: string;
  };
  organization: { id: string; name: string; slug: string; primaryColor: string | null; logoUrl: string | null };
  role: string;
  permissions: string[];
  isOwner: boolean;
}

export type ConversationStatus = 'new' | 'queued' | 'assigned' | 'active' | 'waiting' | 'resolved' | 'closed';
export type Priority = 'low' | 'normal' | 'high' | 'urgent' | 'critical';

export interface ConversationSummary {
  id: string;
  reference: string;
  subject: string | null;
  channel: string;
  status: ConversationStatus;
  priority: Priority;
  assigneeType: string;
  assigneeId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  messageCount: number;
  customer: { id: string; displayName: string | null; avatarUrl: string | null; tier: string | null } | null;
  queue: { id: string; name: string } | null;
  intelligence: { sentiment: string | null; sentimentScore: number | null; intent: string | null } | null;
}

export interface Message {
  id: string;
  direction: 'inbound' | 'outbound' | 'internal';
  type: string;
  authorType: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  bodyHtml: string | null;
  deliveryState: string;
  citations: { index: number; title: string; heading?: string; uri?: string }[];
  isPrivate: boolean;
  createdAt: string;
}

export interface CustomerOverview {
  customer: {
    id: string;
    displayName: string | null;
    company: string | null;
    tier: string | null;
    locale: string;
    tags: string[];
    contactMethods: { kind: string; value: string; isPrimary: boolean }[];
    aiContext: {
      summary: string | null;
      intent: string | null;
      sentiment: string | null;
      riskLevel: string | null;
      currentIssue: string | null;
      topics: string[];
    } | null;
  };
  conversations: { id: string; reference: string; subject: string | null; channel: string; status: string; createdAt: string }[];
  tickets: { id: string; reference: string; subject: string; status: string; priority: string; createdAt: string }[];
  notes: { id: string; body: string; isPinned: boolean; createdAt: string }[];
  activities: { id: string; kind: string; title: string; summary: string | null; occurredAt: string }[];
}

export interface Agent {
  id: string;
  name: string;
  key: string;
  description: string | null;
  state: string;
  activeVersionId: string | null;
  draftVersionId: string | null;
  versions: { id: string; version: number; publishedAt: string | null; environment: string }[];
}

export interface ExecutionDebug {
  execution: {
    id: string;
    status: string;
    triggerType: string;
    error: string | null;
    durationMs: number | null;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    startedAt: string | null;
    finishedAt: string | null;
  };
  steps: {
    sequence: number;
    nodeId: string;
    nodeType: string;
    nodeName: string | null;
    status: string;
    input: unknown;
    output: unknown;
    error: string | null;
    model: string | null;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    durationMs: number | null;
  }[];
  toolCalls: { id: string; status: string; durationMs: number; input: unknown; output: unknown }[];
  guardrails: { id: string; stage: string; check: string; action: string; severity: string; detail: unknown }[];
}

export interface ExecutiveAnalytics {
  interactions: number;
  resolved: number;
  resolutionRate: number;
  aiHandled: number;
  aiResolutionRate: number;
  deflectionRate: number;
  csat: { average: number | null; responses: number };
  sla: { type: string; met: number; breached: number; attainmentPercent: number }[];
  aiCostUsd: number;
  aiTokens: number;
  openNow: number;
}
