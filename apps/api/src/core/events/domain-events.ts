/** The event names published by the platform. Mirrors docs/events/catalog.md. */
export const DomainEvent = {
  OrganizationCreated: 'organization.created',
  WorkspaceCreated: 'workspace.created',
  UserInvited: 'user.invited',
  UserActivated: 'user.activated',
  UserDeactivated: 'user.deactivated',
  AgentPresenceChanged: 'user.presence_changed',
  RoleChanged: 'role.changed',
  SessionCreated: 'session.created',
  ApiKeyCreated: 'apikey.created',
  ApiKeyRevoked: 'apikey.revoked',

  CustomerCreated: 'customer.created',
  CustomerUpdated: 'customer.updated',
  CustomerMerged: 'customer.merged',
  CustomerContextGenerated: 'customer.context.generated',

  ConversationCreated: 'conversation.created',
  ConversationQueued: 'conversation.queued',
  ConversationAssigned: 'conversation.assigned',
  ConversationTransferred: 'conversation.transferred',
  ConversationStatusChanged: 'conversation.status.changed',
  ConversationResolved: 'conversation.resolved',
  ConversationClosed: 'conversation.closed',
  MessageCreated: 'message.created',
  MessageDeliveryUpdated: 'message.delivery.updated',

  ChannelInboundReceived: 'channel.inbound.received',
  ChannelOutboundSent: 'channel.outbound.sent',
  ChannelDeliveryFailed: 'channel.delivery.failed',

  TicketCreated: 'ticket.created',
  TicketUpdated: 'ticket.updated',
  TicketAssigned: 'ticket.assigned',
  TicketResolved: 'ticket.resolved',
  TicketReopened: 'ticket.reopened',
  TicketClosed: 'ticket.closed',

  SlaStarted: 'sla.started',
  SlaWarning: 'sla.warning',
  SlaBreached: 'sla.breached',
  SlaMet: 'sla.met',

  RoutingEvaluated: 'routing.evaluated',
  RoutingAssigned: 'routing.assigned',
  RoutingUnassignable: 'routing.unassignable',
  AutomationFired: 'automation.fired',

  KnowledgeArticlePublished: 'knowledge.article.published',
  KnowledgeDocumentIngested: 'knowledge.document.ingested',
  KnowledgeSourceSynced: 'knowledge.source.synced',
  RagIndexed: 'rag.indexed',
  RagRetrieved: 'rag.retrieved',

  AiCompletionFinished: 'ai.completion.finished',
  AgentPublished: 'agent.published',
  ExecutionStarted: 'execution.started',
  ExecutionStepFinished: 'execution.step.finished',
  ExecutionSuspended: 'execution.suspended',
  ExecutionFinished: 'execution.finished',
  ExecutionFailed: 'execution.failed',
  ToolInvoked: 'tool.invoked',
  GuardrailTriggered: 'guardrail.triggered',
  HandoffRequested: 'handoff.requested',

  QcEvaluated: 'qc.evaluated',
  QcDisputed: 'qc.disputed',
  QcRealtimeAlert: 'qc.realtime.alert',
  IntelExtracted: 'intel.extracted',

  NotificationSent: 'notification.sent',
  UsageRecorded: 'usage.recorded',
  WebhookDeliveryFailed: 'webhook.delivery.failed',
} as const;

export type DomainEventType = (typeof DomainEvent)[keyof typeof DomainEvent];

export interface DomainEventEnvelope<T = Record<string, unknown>> {
  id: string;
  type: DomainEventType | string;
  version: number;
  occurredAt: string;
  organizationId: string;
  workspaceId?: string;
  actor: { type: string; id?: string };
  subject: { type: string; id: string };
  correlationId?: string;
  causationId?: string;
  data: T;
}
