/* eslint-disable */
// Generated from the Atrrehub OpenAPI document. Do not edit by hand —
// run `pnpm --filter @atrrehub/sdk generate` against a running API.

import type { HttpClient, RequestOptions } from './http.js';

/**
 * Every operation the API exposes, as a method.
 *
 * Return types are `unknown` by design: the API validates request and
 * response bodies with Zod schemas that OpenAPI cannot fully express, and a
 * generated type that is subtly wrong is worse than no type at all. Narrow
 * with your own type on the call: `await api.listWebhooks<Endpoint[]>()`.
 */
export class Operations {
  constructor(protected readonly http: HttpClient) {}

  /** Accept an invitation and sign in */
  acceptInviteIam<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/users/accept-invite`, { ...options, body });
  }

  /** Acknowledge a real-time signal */
  acknowledgeQuality<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/quality/signals/${encodeURIComponent(id)}/acknowledge`, { ...options, body });
  }

  /** Make this the flow inbound calls enter */
  activateFlowVoice<T = unknown>(flowId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/ivr/${encodeURIComponent(flowId)}/activate`, { ...options, body });
  }

  /** Add cases to a dataset */
  addCasesEvaluation<T = unknown>(datasetId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/evaluation/datasets/${encodeURIComponent(datasetId)}/cases`, { ...options, body });
  }

  /** Add a comment */
  addCommentTickets<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/tickets/${encodeURIComponent(id)}/comments`, { ...options, body });
  }

  /** Add a contact method */
  addContactMethodCustomers<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/customers/${encodeURIComponent(id)}/contact-methods`, { ...options, body });
  }

  /** Add a holiday */
  addHolidayDirectory<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/business-hours/${encodeURIComponent(id)}/holidays`, { ...options, body });
  }

  /** Add a customer note */
  addNoteCustomers<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/customers/${encodeURIComponent(id)}/notes`, { ...options, body });
  }

  /** Add a phone number and say what answers it */
  addNumberVoice<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/numbers`, { ...options, body });
  }

  /** Adherence and conformance over a date range */
  adherenceWfm<T = unknown>(query: { "from": string | number | boolean; "to": string | number | boolean; "userId"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/wfm/adherence`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Agent performance: AHT, FCR, CSAT, QA score */
  agentsAnalytics<T = unknown>(query?: { "from"?: string | number | boolean; "to"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/analytics/agents`, { ...options, query: { ...query, ...options?.query } });
  }

  /** AI performance: deflection, handoff, tokens, cost, latency, guardrails */
  aiAnalytics<T = unknown>(query?: { "from"?: string | number | boolean; "to"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/analytics/ai`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Generate draft shifts from a template across a date range */
  applyTemplateWfm<T = unknown>(templateId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/templates/${encodeURIComponent(templateId)}/apply`, { ...options, body });
  }

  /** Approve time off; colliding shifts are cancelled */
  approveWfm<T = unknown>(requestId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/time-off/${encodeURIComponent(requestId)}/approve`, { ...options, body });
  }

  /** Assign to an agent or AI agent, or return to the queue */
  assignConversations<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/conversations/${encodeURIComponent(id)}/assign`, { ...options, body });
  }

  /** Suggest, rewrite, summarize, translate, adjust tone or recommend the next action */
  assistCopilot<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/copilot/assist`, { ...options, body });
  }

  /** SLA attainment over a period */
  attainmentSla<T = unknown>(query: { "from": string | number | boolean; "to": string | number | boolean; "type"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/sla/attainment`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Channels this deployment can serve, with capabilities */
  availableChannels<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/channels`, { ...options });
  }

  /** Recompute a range of days, to repair a gap in the rollups */
  backfillBilling<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/billing/metrics/backfill`, { ...options, body });
  }

  /** Begin TOTP enrolment */
  beginMfaAuth<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/mfa/setup`, { ...options, body });
  }

  /** Begin a login; returns the provider URL to redirect to */
  beginSso<T = unknown>(connectionId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/sso/connections/${encodeURIComponent(connectionId)}/authorize`, { ...options, body });
  }

  /** Apply one change set to many tickets */
  bulkTickets<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/tickets/bulk`, { ...options, body });
  }

  /** Evaluator drift against the AI baseline */
  calibrationQuality<T = unknown>(templateId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/quality/calibration/${encodeURIComponent(templateId)}`, { ...options });
  }

  /** Complete a login and exchange it for platform tokens */
  callbackSso<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/sso/callback`, { ...options, body });
  }

  /** Cancel a running execution */
  cancelAgents<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/agents/executions/${encodeURIComponent(id)}/cancel`, { ...options, body });
  }

  /** Cancel a shift */
  cancelShiftWfm<T = unknown>(shiftId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/wfm/shifts/${encodeURIComponent(shiftId)}`, { ...options });
  }

  /** Events a notification rule can subscribe to */
  catalogNotifications<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/notifications/events`, { ...options });
  }

  /** Providers on offer, with the credentials each needs */
  catalogueIntegrations<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/integrations/catalogue`, { ...options });
  }

  /** Sources a report can be built from, with their metrics and filters */
  catalogueReports<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/reports/sources`, { ...options });
  }

  /** Event types an endpoint can subscribe to */
  catalogueWebhooks<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/webhooks/events`, { ...options });
  }

  /** The node palette for the visual builder */
  catalogWorkflows<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/workflows/node-catalog`, { ...options });
  }

  /** Change the current password */
  changePasswordAuth<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/change-password`, { ...options, body });
  }

  /** Change plan; a downgrade below current usage is refused */
  changePlanBilling<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/billing/plan`, { ...options, body });
  }

  /** Channel performance */
  channelsAnalytics<T = unknown>(query?: { "from"?: string | number | boolean; "to"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/analytics/channels`, { ...options, query: { ...query, ...options?.query } });
  }

  /** SLA clocks for a conversation or ticket */
  clocksSla<T = unknown>(subjectType: string, subjectId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/sla/clocks/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}`, { ...options });
  }

  /** List ticket comments */
  commentsTickets<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/tickets/${encodeURIComponent(id)}/comments`, { ...options });
  }

  /** Diff two runs, listing regressions first */
  compareEvaluation<T = unknown>(runId: string, candidateRunId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/evaluation/runs/${encodeURIComponent(runId)}/compare/${encodeURIComponent(candidateRunId)}`, { ...options });
  }

  /** Recompute adherence for a day */
  computeAdherenceWfm<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/adherence/compute`, { ...options, body });
  }

  /** Branding and greeting for the widget */
  configWidget<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/widget/config`, { ...options });
  }

  /** Confirm TOTP enrolment and receive recovery codes */
  confirmMfaAuth<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/mfa/confirm`, { ...options, body });
  }

  /** Extracted intelligence for one conversation */
  conversationIntelligenceAnalytics<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/analytics/conversations/${encodeURIComponent(id)}/intelligence`, { ...options });
  }

  /** Count the customers matching a segment */
  countSegmentCustomers<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/customers/segments/${encodeURIComponent(id)}/count`, { ...options });
  }

  /** Rostered heads against required heads, interval by interval */
  coverageWfm<T = unknown>(forecastId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/wfm/forecasts/${encodeURIComponent(forecastId)}/coverage`, { ...options });
  }

  /** Connect a channel account */
  createAccountChannels<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/channels/accounts`, { ...options, body });
  }

  /** Create an AI agent with its first draft version */
  createAgents<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/agents`, { ...options, body });
  }

  /** Create an API key — the secret is shown only once */
  createApiKeyIam<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/api-keys`, { ...options, body });
  }

  /** Create a draft article */
  createArticleKnowledge<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/knowledge/articles`, { ...options, body });
  }

  /** Create an automation rule */
  createAutomation<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/automation/rules`, { ...options, body });
  }

  /** Create a knowledge base */
  createBaseKnowledge<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/knowledge/bases`, { ...options, body });
  }

  /** Create a business-hours calendar */
  createBusinessHoursDirectory<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/business-hours`, { ...options, body });
  }

  /** Create a category */
  createCategoryKnowledge<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/knowledge/bases/${encodeURIComponent(id)}/categories`, { ...options, body });
  }

  /** Open a conversation */
  createConversations<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/conversations`, { ...options, body });
  }

  /** Create a customer */
  createCustomers<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/customers`, { ...options, body });
  }

  /** Define a custom field */
  createCustomFieldDirectory<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/custom-fields`, { ...options, body });
  }

  /** Create an evaluation dataset */
  createDatasetEvaluation<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/evaluation/datasets`, { ...options, body });
  }

  /** Take a backup now */
  createDr<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/dr/backups`, { ...options, body });
  }

  /** Create an IVR flow; a flow that cannot be walked is refused */
  createFlowVoice<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/ivr`, { ...options, body });
  }

  /** Forecast volume from history and size every interval */
  createForecastWfm<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/forecasts`, { ...options, body });
  }

  /** Create a guardrail policy */
  createGuardrails<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/guardrails/policies`, { ...options, body });
  }

  /** Connect a provider; it stays disabled until tested */
  createIntegrations<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/integrations`, { ...options, body });
  }

  /** Create an SLA policy */
  createPolicySla<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/sla/policies`, { ...options, body });
  }

  /** Create a queue */
  createQueueDirectory<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/queues`, { ...options, body });
  }

  /** Save a report definition */
  createReports<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/reports`, { ...options, body });
  }

  /** Create a custom role */
  createRoleIam<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/roles`, { ...options, body });
  }

  /** Create a notification rule */
  createRuleNotifications<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/notifications/rules`, { ...options, body });
  }

  /** Create a routing rule */
  createRuleRouting<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/routing/rules`, { ...options, body });
  }

  /** Create a saved reply */
  createSavedReplyDirectory<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/saved-replies`, { ...options, body });
  }

  /** Create a customer segment */
  createSegmentCustomers<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/customers/segments`, { ...options, body });
  }

  /** Roster a shift; double-booking and approved time off are refused */
  createShiftWfm<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/shifts`, { ...options, body });
  }

  /** Register a knowledge source */
  createSourceKnowledge<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/knowledge/sources`, { ...options, body });
  }

  /** Add an OIDC connection for an email domain */
  createSso<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/sso/connections`, { ...options, body });
  }

  /** Create a tag */
  createTagDirectory<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/tags`, { ...options, body });
  }

  /** Create a team */
  createTeamDirectory<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/teams`, { ...options, body });
  }

  /** Create a QC template; criterion weights must total 100 */
  createTemplateQuality<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/quality/templates`, { ...options, body });
  }

  /** Create a ticket template */
  createTemplateTickets<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/tickets/templates`, { ...options, body });
  }

  /** Create a shift template */
  createTemplateWfm<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/templates`, { ...options, body });
  }

  /** Create a ticket */
  createTickets<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/tickets`, { ...options, body });
  }

  /** Define a custom HTTP tool */
  createTools<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/tools`, { ...options, body });
  }

  /** Provision a user */
  createUserScim<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/scim/v2/Users`, { ...options, body });
  }

  /** Register an endpoint; the signing secret is returned once */
  createWebhooks<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/webhooks`, { ...options, body });
  }

  /** Create a workflow */
  createWorkflows<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/workflows`, { ...options, body });
  }

  /** Create a workspace */
  createWorkspaceTenancy<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/workspaces`, { ...options, body });
  }

  /** Record a satisfaction score */
  csatConversations<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/conversations/${encodeURIComponent(id)}/csat`, { ...options, body });
  }

  /** AI customer context for the workspace rail */
  customerContextCopilot<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/copilot/customers/${encodeURIComponent(id)}/context`, { ...options });
  }

  /** Execution debugger: steps, LLM calls, tool calls, guardrails, cost */
  debugAgents<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/agents/executions/${encodeURIComponent(id)}`, { ...options });
  }

  /** Decline time off */
  declineWfm<T = unknown>(requestId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/time-off/${encodeURIComponent(requestId)}/decline`, { ...options, body });
  }

  /** Disconnect a channel account */
  deleteAccountChannels<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/channels/accounts/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete an agent */
  deleteAgents<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/agents/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete an article */
  deleteArticleKnowledge<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/knowledge/articles/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete an automation rule */
  deleteAutomation<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/automation/rules/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a knowledge base */
  deleteBaseKnowledge<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/knowledge/bases/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a business-hours calendar */
  deleteBusinessHoursDirectory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/business-hours/${encodeURIComponent(id)}`, { ...options });
  }

  /** Remove a case from a dataset */
  deleteCaseEvaluation<T = unknown>(datasetId: string, caseId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/evaluation/datasets/${encodeURIComponent(datasetId)}/cases/${encodeURIComponent(caseId)}`, { ...options });
  }

  /** Delete a category */
  deleteCategoryKnowledge<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/knowledge/categories/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a customer */
  deleteCustomers<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/customers/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a custom field definition */
  deleteCustomFieldDirectory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/custom-fields/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a dataset and everything scored against it */
  deleteDatasetEvaluation<T = unknown>(datasetId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/evaluation/datasets/${encodeURIComponent(datasetId)}`, { ...options });
  }

  /** Delete a document and its chunks */
  deleteDocumentKnowledge<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/knowledge/documents/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete an IVR flow */
  deleteFlowVoice<T = unknown>(flowId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/voice/ivr/${encodeURIComponent(flowId)}`, { ...options });
  }

  /** Delete a forecast */
  deleteForecastWfm<T = unknown>(forecastId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/wfm/forecasts/${encodeURIComponent(forecastId)}`, { ...options });
  }

  /** Delete a guardrail policy */
  deleteGuardrails<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/guardrails/policies/${encodeURIComponent(id)}`, { ...options });
  }

  /** Remove a holiday */
  deleteHolidayDirectory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/holidays/${encodeURIComponent(id)}`, { ...options });
  }

  /** Remove an integration */
  deleteIntegrations<T = unknown>(integrationId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/integrations/${encodeURIComponent(integrationId)}`, { ...options });
  }

  /** Delete a customer note */
  deleteNoteCustomers<T = unknown>(id: string, noteId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/customers/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`, { ...options });
  }

  /** Release a phone number */
  deleteNumberVoice<T = unknown>(numberId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/voice/numbers/${encodeURIComponent(numberId)}`, { ...options });
  }

  /** Delete an SLA policy */
  deletePolicySla<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/sla/policies/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete an empty queue */
  deleteQueueDirectory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/queues/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a saved report */
  deleteReports<T = unknown>(reportId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/reports/${encodeURIComponent(reportId)}`, { ...options });
  }

  /** Delete a custom role */
  deleteRoleIam<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/roles/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a notification rule */
  deleteRuleNotifications<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/notifications/rules/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a routing rule */
  deleteRuleRouting<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/routing/rules/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a saved reply */
  deleteSavedReplyDirectory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/saved-replies/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a segment */
  deleteSegmentCustomers<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/customers/segments/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a knowledge source */
  deleteSourceKnowledge<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/knowledge/sources/${encodeURIComponent(id)}`, { ...options });
  }

  /** Remove an SSO connection */
  deleteSso<T = unknown>(connectionId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/sso/connections/${encodeURIComponent(connectionId)}`, { ...options });
  }

  /** Delete a tag */
  deleteTagDirectory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/tags/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a team */
  deleteTeamDirectory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/teams/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a QC template */
  deleteTemplateQuality<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/quality/templates/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a ticket template */
  deleteTemplateTickets<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/tickets/templates/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a shift template */
  deleteTemplateWfm<T = unknown>(templateId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/wfm/templates/${encodeURIComponent(templateId)}`, { ...options });
  }

  /** Delete a ticket */
  deleteTickets<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/tickets/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a custom tool */
  deleteTools<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/tools/${encodeURIComponent(id)}`, { ...options });
  }

  /** Deprovision a user */
  deleteUserScim<T = unknown>(userId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/scim/v2/Users/${encodeURIComponent(userId)}`, { ...options });
  }

  /** Delete a workflow */
  deleteWorkflows<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/workflows/${encodeURIComponent(id)}`, { ...options });
  }

  /** Delete a workspace */
  deleteWorkspaceTenancy<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/workspaces/${encodeURIComponent(id)}`, { ...options });
  }

  /** Recent delivery attempts across every endpoint */
  deliveriesWebhooks<T = unknown>(query?: { "endpointId"?: string | number | boolean; "status"?: string | number | boolean; "limit"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/webhooks/deliveries`, { ...options, query: { ...query, ...options?.query } });
  }

  /** One delivery, including the payload that was sent */
  deliveryWebhooks<T = unknown>(deliveryId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/webhooks/deliveries/${encodeURIComponent(deliveryId)}`, { ...options });
  }

  /** Stop syncing without discarding the configuration */
  disableIntegrations<T = unknown>(integrationId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/integrations/${encodeURIComponent(integrationId)}/disable`, { ...options, body });
  }

  /** Disable multi-factor authentication */
  disableMfaAuth<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/mfa/disable`, { ...options, body });
  }

  /** Disable the connection and return the domain to passwords */
  disableSso<T = unknown>(connectionId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/sso/connections/${encodeURIComponent(connectionId)}/disable`, { ...options, body });
  }

  /** Whether an email domain is routed to SSO */
  discoverSso<T = unknown>(query: { "email": string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/sso/discover`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Dispute an evaluation */
  disputeQuality<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/quality/evaluations/${encodeURIComponent(id)}/dispute`, { ...options, body });
  }

  /** Assign queued conversations while capacity allows */
  drainRouting<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/routing/queues/${encodeURIComponent(id)}/drain`, { ...options, body });
  }

  /** Enable syncing; requires a successful test */
  enableIntegrations<T = unknown>(integrationId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/integrations/${encodeURIComponent(integrationId)}/enable`, { ...options, body });
  }

  /** Enable the connection; the provider keys must be reachable first */
  enableSso<T = unknown>(connectionId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/sso/connections/${encodeURIComponent(connectionId)}/enable`, { ...options, body });
  }

  /** What this period would cost at list price */
  estimateBilling<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/billing/invoice-estimate`, { ...options });
  }

  /** Run an AI evaluation of a conversation */
  evaluateQuality<T = unknown>(conversationId: string, body?: unknown, query?: { "templateId"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/quality/evaluate/${encodeURIComponent(conversationId)}`, { ...options, body, query: { ...query, ...options?.query } });
  }

  /** Recent guardrail decisions */
  eventsGuardrails<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/guardrails/events`, { ...options });
  }

  /** List recent executions */
  executionsAgents<T = unknown>(query?: { "status"?: string | number | boolean; "agentId"?: string | number | boolean; "conversationId"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/agents/executions`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Executive dashboard: volume, resolution, AI deflection, CSAT, SLA, cost */
  executiveAnalytics<T = unknown>(query?: { "from"?: string | number | boolean; "to"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/analytics/executive`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Run a saved report and download it as CSV */
  exportCsvReports<T = unknown>(reportId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/reports/${encodeURIComponent(reportId)}/export.csv`, { ...options });
  }

  /** Extract intelligence for a conversation now */
  extractAnalytics<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/analytics/conversations/${encodeURIComponent(id)}/intelligence`, { ...options, body });
  }

  /** Memory scoped to a conversation */
  forConversationMemory<T = unknown>(id: string, query?: { "limit"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/memory/conversations/${encodeURIComponent(id)}`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Everything the platform remembers about a customer */
  forCustomerMemory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/memory/customers/${encodeURIComponent(id)}`, { ...options });
  }

  /** Erase all memory for a customer */
  forgetCustomerMemory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/memory/customers/${encodeURIComponent(id)}`, { ...options });
  }

  /** Send a password reset link */
  forgotPasswordAuth<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/forgot-password`, { ...options, body });
  }

  /** Open a ticket from a conversation, carrying its context */
  fromConversationTickets<T = unknown>(conversationId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/tickets/from-conversation/${encodeURIComponent(conversationId)}`, { ...options, body });
  }

  /** Create a ticket from a template */
  fromTemplateTickets<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/tickets/templates/${encodeURIComponent(id)}/instantiate`, { ...options, body });
  }

  /** Read an agent with its versions */
  getAgents<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/agents/${encodeURIComponent(id)}`, { ...options });
  }

  /** Read an article with its recent versions */
  getArticleKnowledge<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/knowledge/articles/${encodeURIComponent(id)}`, { ...options });
  }

  /** Read a knowledge base */
  getBaseKnowledge<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/knowledge/bases/${encodeURIComponent(id)}`, { ...options });
  }

  /** Read a conversation */
  getConversations<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/conversations/${encodeURIComponent(id)}`, { ...options });
  }

  /** Read a customer */
  getCustomers<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/customers/${encodeURIComponent(id)}`, { ...options });
  }

  /** Get a dataset with its cases and recent runs */
  getDatasetEvaluation<T = unknown>(datasetId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/evaluation/datasets/${encodeURIComponent(datasetId)}`, { ...options });
  }

  /** Get a backup with its verification checks */
  getDr<T = unknown>(backupId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/dr/backups/${encodeURIComponent(backupId)}`, { ...options });
  }

  /** Read an evaluation with per-criterion scores and evidence */
  getEvaluationQuality<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/quality/evaluations/${encodeURIComponent(id)}`, { ...options });
  }

  /** Get an IVR flow */
  getFlowVoice<T = unknown>(flowId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/voice/ivr/${encodeURIComponent(flowId)}`, { ...options });
  }

  /** Get a forecast with every interval */
  getForecastWfm<T = unknown>(forecastId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/wfm/forecasts/${encodeURIComponent(forecastId)}`, { ...options });
  }

  /** Get a data plane with its recent heartbeats */
  getHybrid<T = unknown>(planeId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/hybrid/data-planes/${encodeURIComponent(planeId)}`, { ...options });
  }

  /** Get an integration */
  getIntegrations<T = unknown>(integrationId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/integrations/${encodeURIComponent(integrationId)}`, { ...options });
  }

  /** Read an SLA policy */
  getPolicySla<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/sla/policies/${encodeURIComponent(id)}`, { ...options });
  }

  /** Read a queue */
  getQueueDirectory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/queues/${encodeURIComponent(id)}`, { ...options });
  }

  /** Get a saved report */
  getReports<T = unknown>(reportId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/reports/${encodeURIComponent(reportId)}`, { ...options });
  }

  /** Get a run with every case result */
  getRunEvaluation<T = unknown>(runId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/evaluation/runs/${encodeURIComponent(runId)}`, { ...options });
  }

  /** Get an SSO connection */
  getSso<T = unknown>(connectionId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/sso/connections/${encodeURIComponent(connectionId)}`, { ...options });
  }

  /** Read a team */
  getTeamDirectory<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/teams/${encodeURIComponent(id)}`, { ...options });
  }

  /** Read a ticket */
  getTickets<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/tickets/${encodeURIComponent(id)}`, { ...options });
  }

  /** Read a member */
  getUserIam<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/users/${encodeURIComponent(id)}`, { ...options });
  }

  /** Get one provisioned user */
  getUserScim<T = unknown>(userId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/scim/v2/Users/${encodeURIComponent(userId)}`, { ...options });
  }

  /** A call with its events, transcript, participants and recordings */
  getVoice<T = unknown>(callId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/voice/calls/${encodeURIComponent(callId)}`, { ...options });
  }

  /** Get an endpoint */
  getWebhooks<T = unknown>(endpointId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/webhooks/${encodeURIComponent(endpointId)}`, { ...options });
  }

  /** Read a workflow with its latest graph and validation issues */
  getWorkflows<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/workflows/${encodeURIComponent(id)}`, { ...options });
  }

  /** Read a workspace */
  getWorkspaceTenancy<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/workspaces/${encodeURIComponent(id)}`, { ...options });
  }

  /** End the call */
  hangupVoice<T = unknown>(callId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/calls/${encodeURIComponent(callId)}/hangup`, { ...options, body });
  }

  /** Receive a data plane heartbeat and return its configuration */
  heartbeatHybrid<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/hybrid/heartbeat`, { ...options, body });
  }

  /** Recorded usage by period, as billing would count it */
  historyBilling<T = unknown>(query?: { "months"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/billing/usage/history`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Conversation audit history */
  historyConversations<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/conversations/${encodeURIComponent(id)}/history`, { ...options });
  }

  /** Field-level ticket history */
  historyTickets<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/tickets/${encodeURIComponent(id)}/history`, { ...options });
  }

  /** Put the caller on hold */
  holdVoice<T = unknown>(callId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/calls/${encodeURIComponent(callId)}/hold`, { ...options, body });
  }

  /** The signed-in agent’s inbox */
  inboxConversations<T = unknown>(query?: { "limit"?: string | number | boolean; "cursor"?: string | number | boolean; "status"?: string | number | boolean; "channel"?: string | number | boolean; "priority"?: string | number | boolean; "queueId"?: string | number | boolean; "assigneeId"?: string | number | boolean; "customerId"?: string | number | boolean; "unassigned"?: string | number | boolean; "q"?: string | number | boolean; "sort"?: string | number | boolean; "tags"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/conversations/inbox`, { ...options, query: { ...query, ...options?.query } });
  }

  /** The signed-in user’s notification inbox */
  inboxNotifications<T = unknown>(query?: { "limit"?: string | number | boolean; "cursor"?: string | number | boolean; "unreadOnly"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/notifications`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Ingest an inbound provider payload */
  ingestChannels<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/channels/ingest`, { ...options, body });
  }

  /** Ingest a URL */
  ingestUrlKnowledge<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/knowledge/documents/url`, { ...options, body });
  }

  /** Intent, topic, complaint and sentiment trends */
  intelligenceTrendsAnalytics<T = unknown>(query?: { "from"?: string | number | boolean; "to"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/analytics/intelligence`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Invite a user to the organization */
  inviteIam<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/users`, { ...options, body });
  }

  /** Recent tool invocations */
  invocationsTools<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/tools/invocations/recent`, { ...options });
  }

  /** Invoke a tool directly, for testing */
  invokeTools<T = unknown>(key: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/tools/${encodeURIComponent(key)}/invoke`, { ...options, body });
  }

  /** List channel accounts */
  listAccountsChannels<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/channels/accounts`, { ...options });
  }

  /** List AI agents */
  listAgents<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/agents`, { ...options });
  }

  /** List API keys */
  listApiKeysIam<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/api-keys`, { ...options });
  }

  /** List articles */
  listArticlesKnowledge<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/knowledge/articles`, { ...options });
  }

  /** List automation rules */
  listAutomation<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/automation/rules`, { ...options });
  }

  /** List knowledge bases */
  listBasesKnowledge<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/knowledge/bases`, { ...options });
  }

  /** List business-hours calendars */
  listBusinessHoursDirectory<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/business-hours`, { ...options });
  }

  /** List conversations */
  listConversations<T = unknown>(query?: { "limit"?: string | number | boolean; "cursor"?: string | number | boolean; "status"?: string | number | boolean; "channel"?: string | number | boolean; "priority"?: string | number | boolean; "queueId"?: string | number | boolean; "assigneeId"?: string | number | boolean; "customerId"?: string | number | boolean; "unassigned"?: string | number | boolean; "q"?: string | number | boolean; "sort"?: string | number | boolean; "tags"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/conversations`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List custom field definitions */
  listCustomFieldsDirectory<T = unknown>(query?: { "entity"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/custom-fields`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List evaluation datasets */
  listDatasetsEvaluation<T = unknown>(query?: { "agentId"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/evaluation/datasets`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List documents and their ingestion status */
  listDocumentsKnowledge<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/knowledge/documents`, { ...options });
  }

  /** List backups and their verification status */
  listDr<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/dr/backups`, { ...options });
  }

  /** List evaluations */
  listEvaluationsQuality<T = unknown>(query?: { "subjectId"?: string | number | boolean; "templateId"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/quality/evaluations`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List IVR flows */
  listFlowsVoice<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/voice/ivr`, { ...options });
  }

  /** List forecasts */
  listForecastsWfm<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/wfm/forecasts`, { ...options });
  }

  /** List groups — the organization’s roles, read-only */
  listGroupsScim<T = unknown>(query?: { "startIndex"?: string | number | boolean; "count"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/scim/v2/Groups`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List guardrail policies */
  listGuardrails<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/guardrails/policies`, { ...options });
  }

  /** List data planes and whether they are reporting */
  listHybrid<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/hybrid/data-planes`, { ...options });
  }

  /** List integrations and their connection status */
  listIntegrations<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/integrations`, { ...options });
  }

  /** List customer notes */
  listNotesCustomers<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/customers/${encodeURIComponent(id)}/notes`, { ...options });
  }

  /** The permission catalog */
  listPermissionsIam<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/permissions`, { ...options });
  }

  /** List SLA policies and their targets */
  listPoliciesSla<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/sla/policies`, { ...options });
  }

  /** List queues */
  listQueuesDirectory<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/queues`, { ...options });
  }

  /** List saved reports */
  listReports<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/reports`, { ...options });
  }

  /** List roles */
  listRolesIam<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/roles`, { ...options });
  }

  /** Model routes, configured providers and defaults */
  listRoutesAi<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/ai/models`, { ...options });
  }

  /** List notification rules */
  listRulesNotifications<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/notifications/rules`, { ...options });
  }

  /** List routing rules in evaluation order */
  listRulesRouting<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/routing/rules`, { ...options });
  }

  /** List evaluation runs */
  listRunsEvaluation<T = unknown>(query?: { "datasetId"?: string | number | boolean; "agentId"?: string | number | boolean; "limit"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/evaluation/runs`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List saved replies */
  listSavedRepliesDirectory<T = unknown>(query?: { "locale"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/saved-replies`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List customer segments */
  listSegmentsCustomers<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/customers/segments`, { ...options });
  }

  /** List shifts in a window */
  listShiftsWfm<T = unknown>(query: { "from": string | number | boolean; "to": string | number | boolean; "userId"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/wfm/shifts`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List knowledge sources */
  listSourcesKnowledge<T = unknown>(query?: { "knowledgeBaseId"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/knowledge/sources`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List SSO connections */
  listSso<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/sso/connections`, { ...options });
  }

  /** List tags */
  listTagsDirectory<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/tags`, { ...options });
  }

  /** List teams */
  listTeamsDirectory<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/teams`, { ...options });
  }

  /** List QC scorecard templates */
  listTemplatesQuality<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/quality/templates`, { ...options });
  }

  /** List ticket templates */
  listTemplatesTickets<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/tickets/templates`, { ...options });
  }

  /** List shift templates */
  listTemplatesWfm<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/wfm/templates`, { ...options });
  }

  /** List and filter tickets */
  listTickets<T = unknown>(query?: { "limit"?: string | number | boolean; "cursor"?: string | number | boolean; "status"?: string | number | boolean; "priority"?: string | number | boolean; "category"?: string | number | boolean; "assigneeId"?: string | number | boolean; "teamId"?: string | number | boolean; "queueId"?: string | number | boolean; "customerId"?: string | number | boolean; "open"?: string | number | boolean; "overdue"?: string | number | boolean; "q"?: string | number | boolean; "sort"?: string | number | boolean; "labels"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/tickets`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List time off requests */
  listTimeOffWfm<T = unknown>(query?: { "from"?: string | number | boolean; "to"?: string | number | boolean; "userId"?: string | number | boolean; "status"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/wfm/time-off`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List built-in and custom tools */
  listTools<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/tools`, { ...options });
  }

  /** List organization members */
  listUsersIam<T = unknown>(query?: { "limit"?: string | number | boolean; "cursor"?: string | number | boolean; "search"?: string | number | boolean; "roleKey"?: string | number | boolean; "status"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/users`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List provisioned users */
  listUsersScim<T = unknown>(query?: { "filter"?: string | number | boolean; "startIndex"?: string | number | boolean; "count"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/scim/v2/Users`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List calls */
  listVoice<T = unknown>(query?: { "status"?: string | number | boolean; "queueId"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/voice/calls`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List endpoints */
  listWebhooks<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/webhooks`, { ...options });
  }

  /** List workflows */
  listWorkflows<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/workflows`, { ...options });
  }

  /** List workspaces */
  listWorkspacesTenancy<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/workspaces`, { ...options });
  }

  /** Live operational snapshot for the wallboard */
  liveAnalytics<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/analytics/live`, { ...options });
  }

  /** Liveness probe */
  liveHealth<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/healthz`, { ...options });
  }

  /** Calls in progress right now */
  liveVoice<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/voice/calls/live`, { ...options });
  }

  /** Authenticate with email and password */
  loginAuth<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/login`, { ...options, body });
  }

  /** Revoke the presented refresh token */
  logoutAuth<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/logout`, { ...options, body });
  }

  /** Record a manual evaluation */
  manualQuality<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/quality/evaluations/manual`, { ...options, body });
  }

  /** Mark every notification as read */
  markAllReadNotifications<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/notifications/read-all`, { ...options, body });
  }

  /** Mark one notification as read */
  markReadNotifications<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/notifications/${encodeURIComponent(id)}/read`, { ...options, body });
  }

  /** The authenticated principal, tenant and permissions */
  meAuth<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/auth/me`, { ...options });
  }

  /** Merge another customer into this one */
  mergeCustomers<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/customers/${encodeURIComponent(id)}/merge`, { ...options, body });
  }

  /** List messages */
  messagesConversations<T = unknown>(id: string, query?: { "limit"?: string | number | boolean; "cursor"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/conversations/${encodeURIComponent(id)}/messages`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Poll the visitor’s own conversation */
  messagesWidget<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/widget/conversations/${encodeURIComponent(id)}/messages`, { ...options });
  }

  /** Metrics the daily rollup produces */
  metricCatalogueBilling<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/billing/metrics/catalogue`, { ...options });
  }

  /** Metrics scored on every case, and their weights */
  metricsEvaluation<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/evaluation/metrics`, { ...options });
  }

  /** Run live quality monitoring now */
  monitorQuality<T = unknown>(conversationId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/quality/monitor/${encodeURIComponent(conversationId)}`, { ...options, body });
  }

  /** Add an internal note, never sent to the customer */
  noteConversations<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/conversations/${encodeURIComponent(id)}/notes`, { ...options, body });
  }

  /** List phone numbers */
  numbersVoice<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/voice/numbers`, { ...options });
  }

  /** Read the current organization */
  organizationTenancy<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/organization`, { ...options });
  }

  /** Place an outbound call */
  originateVoice<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/calls`, { ...options, body });
  }

  /** Record a negotiated limit override against the subscription */
  overridesBilling<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/billing/limits`, { ...options, body });
  }

  /** Customer 360 overview: profile, conversations, tickets, notes, activity */
  overviewCustomers<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/customers/${encodeURIComponent(id)}/overview`, { ...options });
  }

  /** Patch a user — usually to deactivate a leaver */
  patchUserScim<T = unknown>(userId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/scim/v2/Users/${encodeURIComponent(userId)}`, { ...options, body });
  }

  /** Send a synthetic event to confirm the endpoint works */
  pingWebhooks<T = unknown>(endpointId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/webhooks/${encodeURIComponent(endpointId)}/ping`, { ...options, body });
  }

  /** Plans and what each one allows */
  plansBilling<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/billing/plans`, { ...options });
  }

  /** Telephony and speech providers this deployment can serve */
  providersVoice<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/voice/providers`, { ...options });
  }

  /** Provision a tenant, its owner and its subscription */
  provisionBilling<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/billing/tenants`, { ...options, body });
  }

  /** Publish the draft into an environment */
  publishAgents<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/agents/${encodeURIComponent(id)}/publish`, { ...options, body });
  }

  /** Publish an article and index it for retrieval */
  publishArticleKnowledge<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/knowledge/articles/${encodeURIComponent(id)}/publish`, { ...options, body });
  }

  /** Publish the draft roster for a window */
  publishWfm<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/shifts/publish`, { ...options, body });
  }

  /** Publish the latest version */
  publishWorkflows<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/workflows/${encodeURIComponent(id)}/publish`, { ...options, body });
  }

  /** Live queue depth and oldest wait */
  queueStatsConversations<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/conversations/queue-stats`, { ...options });
  }

  /** Is there a backup, is it recent, and has anyone proved it restores? */
  readinessDr<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/dr/readiness`, { ...options });
  }

  /** Readiness probe */
  readyHealth<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/readyz`, { ...options });
  }

  /** Download a recording from the platform’s own store */
  recordingVoice<T = unknown>(callId: string, recordingId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/voice/calls/${encodeURIComponent(callId)}/recordings/${encodeURIComponent(recordingId)}`, { ...options });
  }

  /** Exchange a refresh token for a new session */
  refreshAuth<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/refresh`, { ...options, body });
  }

  /** Regenerate the AI customer context */
  refreshContextCopilot<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/copilot/customers/${encodeURIComponent(id)}/context/refresh`, { ...options, body });
  }

  /** Create an account and its organization */
  registerAuth<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/register`, { ...options, body });
  }

  /** Register a data plane; its enrollment token is shown once */
  registerHybrid<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/hybrid/data-planes`, { ...options, body });
  }

  /** Re-run ingestion for a document */
  reindexKnowledge<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/knowledge/documents/${encodeURIComponent(id)}/reindex`, { ...options, body });
  }

  /** Remove a contact method */
  removeContactMethodCustomers<T = unknown>(id: string, methodId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/customers/${encodeURIComponent(id)}/contact-methods/${encodeURIComponent(methodId)}`, { ...options });
  }

  /** Remove a member from the organization */
  removeUserIam<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/users/${encodeURIComponent(id)}`, { ...options });
  }

  /** Remove an endpoint and its delivery history */
  removeWebhooks<T = unknown>(endpointId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/webhooks/${encodeURIComponent(endpointId)}`, { ...options });
  }

  /** Replace a user */
  replaceUserScim<T = unknown>(userId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PUT", `/scim/v2/Users/${encodeURIComponent(userId)}`, { ...options, body });
  }

  /** Send the same event again as a new delivery */
  replayWebhooks<T = unknown>(deliveryId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`, { ...options, body });
  }

  /** Reply to the customer through the conversation’s channel */
  replyConversations<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/conversations/${encodeURIComponent(id)}/messages`, { ...options, body });
  }

  /** Request time off */
  requestTimeOffWfm<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/time-off`, { ...options, body });
  }

  /** Set a new password using a reset token */
  resetPasswordAuth<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/reset-password`, { ...options, body });
  }

  /** Check whether a payload could legally cross the boundary */
  residencyHybrid<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/hybrid/residency-check`, { ...options, body });
  }

  /** Resolve a dispute, optionally overriding the score */
  resolveDisputeQuality<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/quality/disputes/${encodeURIComponent(id)}/resolve`, { ...options, body });
  }

  /** Resume a suspended execution */
  resumeAgents<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/agents/executions/${encodeURIComponent(id)}/resume`, { ...options, body });
  }

  /** Return a suspended tenant to service */
  resumeBilling<T = unknown>(organizationId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/billing/tenants/${encodeURIComponent(organizationId)}/resume`, { ...options, body });
  }

  /** Accept heartbeats again */
  resumeHybrid<T = unknown>(planeId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/hybrid/data-planes/${encodeURIComponent(planeId)}/resume`, { ...options, body });
  }

  /** Take the caller off hold */
  resumeVoice<T = unknown>(callId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/calls/${encodeURIComponent(callId)}/resume`, { ...options, body });
  }

  /** Retrieval quality over a period */
  retrievalStatsKnowledge<T = unknown>(query: { "from": string | number | boolean; "to": string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/knowledge/retrieval-stats`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Revoke an API key */
  revokeApiKeyIam<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/api-keys/${encodeURIComponent(id)}`, { ...options });
  }

  /** Sign out of every device */
  revokeSessionsAuth<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("DELETE", `/auth/sessions`, { ...options });
  }

  /** Roll back to a previously published version */
  rollbackAgents<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/agents/${encodeURIComponent(id)}/rollback`, { ...options, body });
  }

  /** Issue or rotate the SCIM bearer token; shown once */
  rotateScimTokenSso<T = unknown>(connectionId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/sso/connections/${encodeURIComponent(connectionId)}/scim-token`, { ...options, body });
  }

  /** Issue a new signing secret; it is returned once */
  rotateWebhooks<T = unknown>(endpointId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/webhooks/${encodeURIComponent(endpointId)}/rotate-secret`, { ...options, body });
  }

  /** Route a conversation now */
  routeRouting<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/routing/conversations/${encodeURIComponent(id)}/route`, { ...options, body });
  }

  /** Run an ad-hoc report definition without saving it */
  runAdHocReports<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/reports/run`, { ...options, body });
  }

  /** Run the agent against a message */
  runAgents<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/agents/${encodeURIComponent(id)}/run`, { ...options, body });
  }

  /** Run a dataset against an agent and score every case */
  runEvaluation<T = unknown>(datasetId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/evaluation/datasets/${encodeURIComponent(datasetId)}/runs`, { ...options, body });
  }

  /** Run a saved report */
  runReports<T = unknown>(reportId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/reports/${encodeURIComponent(reportId)}/run`, { ...options, body });
  }

  /** Recent automation runs */
  runsAutomation<T = unknown>(query?: { "ruleId"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/automation/runs`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Save the graph and return validation issues */
  saveGraphWorkflows<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PUT", `/workflows/${encodeURIComponent(id)}/graph`, { ...options, body });
  }

  /** Speak to the caller */
  sayVoice<T = unknown>(callId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/calls/${encodeURIComponent(callId)}/say`, { ...options, body });
  }

  /** Grade the forecast against what actually arrived */
  scoreWfm<T = unknown>(forecastId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/forecasts/${encodeURIComponent(forecastId)}/score`, { ...options, body });
  }

  /** Search the audit trail */
  searchAudit<T = unknown>(query?: { "actorId"?: string | number | boolean; "action"?: string | number | boolean; "resourceType"?: string | number | boolean; "resourceId"?: string | number | boolean; "from"?: string | number | boolean; "to"?: string | number | boolean; "limit"?: string | number | boolean; "cursor"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/audit`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Search customers */
  searchCustomers<T = unknown>(query?: { "limit"?: string | number | boolean; "cursor"?: string | number | boolean; "q"?: string | number | boolean; "tier"?: string | number | boolean; "company"?: string | number | boolean; "tags"?: string | number | boolean; "segmentId"?: string | number | boolean; "sort"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/customers`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Hybrid retrieval with citations */
  searchKnowledge<T = unknown>(query: { "q": string | number | boolean; "knowledgeBaseIds"?: string | number | boolean; "locale"?: string | number | boolean; "topK"?: string | number | boolean; "rerank"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/knowledge/search`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Send a message from the chat widget */
  sendWidget<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/widget/messages`, { ...options, body });
  }

  /** A daily time series for charting */
  seriesAnalytics<T = unknown>(metric: string, query?: { "from"?: string | number | boolean; "to"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/analytics/series/${encodeURIComponent(metric)}`, { ...options, query: { ...query, ...options?.query } });
  }

  /** A daily series from the rollup table rather than live tables */
  seriesBilling<T = unknown>(query: { "metric": string | number | boolean; "from": string | number | boolean; "to": string | number | boolean; "dimensionValue"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/billing/metrics/series`, { ...options, query: { ...query, ...options?.query } });
  }

  /** List active sessions */
  sessionsAuth<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/auth/sessions`, { ...options });
  }

  /** Set AI memory consent; withdrawing it removes identifiable memory already held */
  setConsentMemory<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/memory/customers/${encodeURIComponent(id)}/consent`, { ...options, body });
  }

  /** Set your own availability */
  setPresenceIam<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/me/presence`, { ...options, body });
  }

  /** Move the conversation through its lifecycle */
  setStatusConversations<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/conversations/${encodeURIComponent(id)}/status`, { ...options, body });
  }

  /** Real-time quality signals for a conversation */
  signalsQuality<T = unknown>(conversationId: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/quality/signals/${encodeURIComponent(conversationId)}`, { ...options });
  }

  /** Preview which rules would fire, without running them */
  simulateAutomation<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/automation/simulate`, { ...options, body });
  }

  /** Preview the routing decision without applying it */
  simulateRouting<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/routing/conversations/${encodeURIComponent(id)}/simulate`, { ...options });
  }

  /** Walk a flow with a sequence of keypresses, without a call */
  simulateVoice<T = unknown>(flowId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/ivr/${encodeURIComponent(flowId)}/simulate`, { ...options, body });
  }

  /** Erlang C: agents needed for an interval, or what given agents deliver */
  staffingWfm<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/wfm/staffing`, { ...options, body });
  }

  /** What this deployment is — mode, region, contract version */
  statusHybrid<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/hybrid/status`, { ...options });
  }

  /** This organization’s subscription */
  subscriptionBilling<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/billing/subscription`, { ...options });
  }

  /** Suspend a tenant and revoke its sessions */
  suspendBilling<T = unknown>(organizationId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/billing/tenants/${encodeURIComponent(organizationId)}/suspend`, { ...options, body });
  }

  /** Stop accepting heartbeats from a plane */
  suspendHybrid<T = unknown>(planeId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/hybrid/data-planes/${encodeURIComponent(planeId)}/suspend`, { ...options, body });
  }

  /** Run the SLA sweep immediately */
  sweepSla<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/sla/sweep`, { ...options, body });
  }

  /** Pull contacts now and reconcile them into Customer 360 */
  syncIntegrations<T = unknown>(integrationId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/integrations/${encodeURIComponent(integrationId)}/sync`, { ...options, body });
  }

  /** Crawl and synchronize a source */
  syncSourceKnowledge<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/knowledge/sources/${encodeURIComponent(id)}/sync`, { ...options, body });
  }

  /** List tenants and their plans */
  tenantsBilling<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/billing/tenants`, { ...options });
  }

  /** Send a prompt through the gateway to verify routing */
  testAi<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/ai/test`, { ...options, body });
  }

  /** Probe the provider and report the fields it actually returns */
  testIntegrations<T = unknown>(integrationId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/integrations/${encodeURIComponent(integrationId)}/test`, { ...options, body });
  }

  /** Fire an event through the rules to verify delivery */
  testNotifications<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/notifications/test`, { ...options, body });
  }

  /** Unified customer timeline */
  timelineCustomers<T = unknown>(id: string, query?: { "limit"?: string | number | boolean; "cursor"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/customers/${encodeURIComponent(id)}/timeline`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Transfer to another agent, team or queue */
  transferConversations<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/conversations/${encodeURIComponent(id)}/transfer`, { ...options, body });
  }

  /** Transfer to a person, a queue or an outside number */
  transferVoice<T = unknown>(callId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/calls/${encodeURIComponent(callId)}/transfer`, { ...options, body });
  }

  /** Run one AI voice turn against what the caller just said */
  turnVoice<T = unknown>(callId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/calls/${encodeURIComponent(callId)}/turn`, { ...options, body });
  }

  /** Unpublish an article and remove it from retrieval */
  unpublishArticleKnowledge<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/knowledge/articles/${encodeURIComponent(id)}/unpublish`, { ...options, body });
  }

  /** Unread notification count, for the badge */
  unreadCountNotifications<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/notifications/unread-count`, { ...options });
  }

  /** Update a channel account */
  updateAccountChannels<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/channels/accounts/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update an article, snapshotting the previous revision */
  updateArticleKnowledge<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/knowledge/articles/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update an automation rule */
  updateAutomation<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/automation/rules/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a knowledge base */
  updateBaseKnowledge<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/knowledge/bases/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a business-hours calendar */
  updateBusinessHoursDirectory<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/business-hours/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Set the configuration a plane pulls on its next heartbeat */
  updateConfigHybrid<T = unknown>(planeId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/hybrid/data-planes/${encodeURIComponent(planeId)}/config`, { ...options, body });
  }

  /** Update subject, priority, tags or locale */
  updateConversations<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/conversations/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a customer */
  updateCustomers<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/customers/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a dataset */
  updateDatasetEvaluation<T = unknown>(datasetId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/evaluation/datasets/${encodeURIComponent(datasetId)}`, { ...options, body });
  }

  /** Edit the draft version; a published version is never modified */
  updateDraftAgents<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/agents/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update an IVR flow */
  updateFlowVoice<T = unknown>(flowId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/voice/ivr/${encodeURIComponent(flowId)}`, { ...options, body });
  }

  /** Update a guardrail policy */
  updateGuardrails<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/guardrails/policies/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Reconfigure an integration; changing how it connects re-tests it */
  updateIntegrations<T = unknown>(integrationId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/integrations/${encodeURIComponent(integrationId)}`, { ...options, body });
  }

  /** Update a phone number */
  updateNumberVoice<T = unknown>(numberId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/voice/numbers/${encodeURIComponent(numberId)}`, { ...options, body });
  }

  /** Update organization profile, branding and localization */
  updateOrganizationTenancy<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/organization`, { ...options, body });
  }

  /** Update an SLA policy */
  updatePolicySla<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/sla/policies/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a queue */
  updateQueueDirectory<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/queues/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a saved report */
  updateReports<T = unknown>(reportId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/reports/${encodeURIComponent(reportId)}`, { ...options, body });
  }

  /** Update a role */
  updateRoleIam<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/roles/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a notification rule */
  updateRuleNotifications<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/notifications/rules/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a routing rule */
  updateRuleRouting<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/routing/rules/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a saved reply */
  updateSavedReplyDirectory<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/saved-replies/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update an SSO connection */
  updateSso<T = unknown>(connectionId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/sso/connections/${encodeURIComponent(connectionId)}`, { ...options, body });
  }

  /** Update a team or its roster */
  updateTeamDirectory<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/teams/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a QC template */
  updateTemplateQuality<T = unknown>(id: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/quality/templates/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a ticket; send If-Match for optimistic locking */
  updateTickets<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/tickets/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a custom tool */
  updateTools<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/tools/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Update a member, their role or workspace scope */
  updateUserIam<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/users/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Reconfigure an endpoint; re-enabling clears its failure count */
  updateWebhooks<T = unknown>(endpointId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/webhooks/${encodeURIComponent(endpointId)}`, { ...options, body });
  }

  /** Update a workspace */
  updateWorkspaceTenancy<T = unknown>(id: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PATCH", `/workspaces/${encodeURIComponent(id)}`, { ...options, body });
  }

  /** Upload a document for ingestion */
  uploadKnowledge<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/knowledge/documents/upload`, { ...options, body });
  }

  /** Set the model route for a role */
  upsertRouteAi<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("PUT", `/ai/models`, { ...options, body });
  }

  /** Token and cost usage by model */
  usageAi<T = unknown>(query?: { "from"?: string | number | boolean; "to"?: string | number | boolean }, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/ai/usage`, { ...options, query: { ...query, ...options?.query } });
  }

  /** Every limit, what is used against it, and what is close */
  usageBilling<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/billing/usage`, { ...options });
  }

  /** Validate the latest graph */
  validateWorkflows<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("GET", `/workflows/${encodeURIComponent(id)}/validate`, { ...options });
  }

  /** Restore into a scratch database and check what came back */
  verifyDr<T = unknown>(backupId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/dr/backups/${encodeURIComponent(backupId)}/verify`, { ...options, body });
  }

  /** Confirm an email address */
  verifyEmailAuth<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/auth/verify-email`, { ...options, body });
  }

  /** Receive a telephony provider callback */
  webhookVoice<T = unknown>(provider: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.http.request<T>("POST", `/voice/webhooks/${encodeURIComponent(provider)}`, { ...options, body });
  }

}
