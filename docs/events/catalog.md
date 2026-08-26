# Event catalog

## Envelope

Every domain event uses the same envelope; consumers must ignore unknown fields.

```json
{
  "id": "evt_01H...",
  "type": "conversation.assigned",
  "version": 1,
  "occurredAt": "2026-02-11T09:31:44.120Z",
  "organizationId": "org_01H...",
  "workspaceId": "wks_01H...",
  "actor": { "type": "user|ai_agent|system|customer", "id": "usr_01H..." },
  "subject": { "type": "conversation", "id": "cnv_01H..." },
  "correlationId": "req_01H...",
  "causationId": "evt_01H...",
  "data": {}
}
```

Delivery is at-least-once. Consumers must be idempotent on `id`. Events are published
through a transactional outbox, so an event exists if and only if its transaction
committed.

## Catalog

### Tenancy & identity
| Type | Data |
|---|---|
| `organization.created` | `{ name, plan }` |
| `workspace.created` | `{ name }` |
| `user.invited` | `{ email, roleId }` |
| `user.activated` | `{ userId }` |
| `user.deactivated` | `{ userId }` |
| `role.changed` | `{ userId, from, to }` |
| `session.created` | `{ userId, ip, userAgent }` |
| `apikey.created` / `apikey.revoked` | `{ apiKeyId }` |

### Customer
| Type | Data |
|---|---|
| `customer.created` | `{ customerId }` |
| `customer.updated` | `{ customerId, changed }` |
| `customer.merged` | `{ sourceId, targetId }` |
| `customer.context.generated` | `{ customerId, summary, intent, sentiment, risk }` |

### Interaction
| Type | Data |
|---|---|
| `conversation.created` | `{ conversationId, channel, customerId }` |
| `conversation.queued` | `{ conversationId, queueId }` |
| `conversation.assigned` | `{ conversationId, assigneeId, assigneeType }` |
| `conversation.transferred` | `{ conversationId, from, to, reason }` |
| `conversation.status.changed` | `{ conversationId, from, to }` |
| `conversation.resolved` | `{ conversationId, resolvedBy, resolutionType }` |
| `conversation.closed` | `{ conversationId }` |
| `message.created` | `{ conversationId, messageId, direction, authorType }` |
| `message.delivery.updated` | `{ messageId, state }` |

### Channels
| Type | Data |
|---|---|
| `channel.inbound.received` | `{ channel, externalId, conversationId }` |
| `channel.outbound.sent` | `{ channel, messageId, providerId }` |
| `channel.delivery.failed` | `{ messageId, reason }` |

### Ticketing & SLA
| Type | Data |
|---|---|
| `ticket.created` | `{ ticketId, customerId, priority }` |
| `ticket.updated` | `{ ticketId, changed }` |
| `ticket.assigned` | `{ ticketId, assigneeId }` |
| `ticket.resolved` / `ticket.reopened` / `ticket.closed` | `{ ticketId }` |
| `sla.started` | `{ targetType, subjectId, dueAt }` |
| `sla.warning` | `{ targetType, subjectId, dueAt, remainingMs }` |
| `sla.breached` | `{ targetType, subjectId, breachedAt }` |
| `sla.met` | `{ targetType, subjectId, elapsedMs }` |

### Routing & automation
| Type | Data |
|---|---|
| `routing.evaluated` | `{ conversationId, ruleId, strategy }` |
| `routing.assigned` | `{ conversationId, assigneeId }` |
| `routing.unassignable` | `{ conversationId, reason }` |
| `automation.fired` | `{ ruleId, subjectType, subjectId, actions }` |

### Knowledge & RAG
| Type | Data |
|---|---|
| `knowledge.article.published` | `{ articleId, version }` |
| `knowledge.document.ingested` | `{ documentId, chunks }` |
| `knowledge.source.synced` | `{ sourceId, added, updated, removed }` |
| `rag.indexed` | `{ documentId, chunkCount, model }` |
| `rag.retrieved` | `{ query, hits, latencyMs }` |

### AI
| Type | Data |
|---|---|
| `ai.completion.finished` | `{ model, promptTokens, completionTokens, costUsd, latencyMs }` |
| `agent.published` | `{ agentId, version, environment }` |
| `execution.started` | `{ executionId, workflowId, version }` |
| `execution.step.finished` | `{ executionId, nodeId, status, durationMs }` |
| `execution.suspended` | `{ executionId, reason, resumeToken }` |
| `execution.finished` | `{ executionId, status, tokens, costUsd }` |
| `execution.failed` | `{ executionId, nodeId, error }` |
| `tool.invoked` | `{ toolId, executionId, status, durationMs }` |
| `guardrail.triggered` | `{ policy, action, severity, subjectId }` |
| `handoff.requested` | `{ conversationId, reason, confidence }` |

### Quality & intelligence
| Type | Data |
|---|---|
| `qc.evaluated` | `{ evaluationId, subjectId, score, templateId }` |
| `qc.disputed` | `{ evaluationId, reason }` |
| `qc.realtime.alert` | `{ conversationId, signal, severity }` |
| `intel.extracted` | `{ conversationId, intent, sentiment, topics }` |

### Platform
| Type | Data |
|---|---|
| `notification.sent` | `{ channel, recipientId, ruleId }` |
| `usage.recorded` | `{ metric, quantity, unit }` |
| `webhook.delivery.failed` | `{ endpointId, attempts, status }` |
