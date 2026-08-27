import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, WebhookEndpoint } from '@prisma/client';
import type { AppConfig } from '../../config/configuration';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { DomainEvent, type DomainEventEnvelope } from '../../core/events/domain-events';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { isEgressAllowed } from '../guardrails/detectors';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  backoffMinutes,
  isValidSubscription,
  matchesEvent,
  newSecret,
  signatureHeader,
} from './signing';

export interface EndpointInput {
  name: string;
  url: string;
  events: string[];
  isActive?: boolean;
}

/** The shape a customer's server receives. Public API — changing it is a break. */
export interface WebhookPayload {
  id: string;
  type: string;
  createdAt: string;
  organizationId: string;
  data: Record<string, unknown>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 12;

/**
 * How many consecutive failures retire an endpoint.
 *
 * With the backoff below, fifteen failures is roughly two days of trying. Past
 * that the endpoint is almost certainly gone rather than briefly down, and
 * continuing to hammer it burns the worker's budget on deliveries nobody will
 * receive. The endpoint is deactivated, never deleted — the customer re-enables
 * it once they have fixed their side, and their delivery history is intact.
 */
const FAILURES_BEFORE_DISABLE = 15;

/** A truncated body is enough to debug with; a full one is an unbounded column. */
const RESPONSE_EXCERPT_LIMIT = 2_000;

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<AppConfig>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly logger: AppLogger,
  ) {}

  // ── Endpoint lifecycle ─────────────────────────────────────────────────────

  async list() {
    const endpoints = await this.prisma.db.webhookEndpoint.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return endpoints.map((endpoint) => this.redact(endpoint));
  }

  async get(endpointId: string) {
    return this.redact(await this.load(endpointId));
  }

  /**
   * The secret is returned exactly once, here. It is stored encrypted and there
   * is no endpoint that gives it back — a customer who loses it rotates it,
   * which is a deliberate five seconds of inconvenience in exchange for the
   * secret not being readable by anyone who gains read access to the API.
   */
  async create(input: EndpointInput) {
    this.assertUrl(input.url);
    const events = this.assertEvents(input.events);

    const secret = newSecret();
    const endpoint = await this.prisma.db.webhookEndpoint.create({
      data: {
        id: newId('webhook'),
        organizationId: RequestContextStore.organizationId()!,
        name: input.name,
        url: input.url,
        secret: this.crypto.encrypt(secret),
        events,
        isActive: input.isActive ?? true,
      },
    });

    await this.audit.record({
      action: 'webhook.created',
      resourceType: 'webhook_endpoint',
      resourceId: endpoint.id,
      after: { name: endpoint.name, url: endpoint.url, events },
    });
    return { ...this.redact(endpoint), secret };
  }

  async update(endpointId: string, input: Partial<EndpointInput>) {
    const existing = await this.load(endpointId);
    if (input.url !== undefined) this.assertUrl(input.url);
    const events = input.events === undefined ? undefined : this.assertEvents(input.events);

    const data: Prisma.WebhookEndpointUpdateInput = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(events === undefined ? {} : { events }),
    };

    // Re-enabling clears the failure history: the count exists to retire a
    // broken endpoint, and a customer who says they have fixed it deserves the
    // full retry budget rather than one attempt before it retires again.
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
      if (input.isActive) {
        data.failureCount = 0;
        data.disabledAt = null;
      }
    }

    const endpoint = await this.prisma.db.webhookEndpoint.update({
      where: { id: endpointId },
      data,
    });
    await this.audit.recordDiff(
      'webhook.updated',
      'webhook_endpoint',
      endpointId,
      { name: existing.name, url: existing.url, events: existing.events, isActive: existing.isActive },
      { name: endpoint.name, url: endpoint.url, events: endpoint.events, isActive: endpoint.isActive },
    );
    return this.redact(endpoint);
  }

  /**
   * Rotate the signing secret.
   *
   * Returns the new secret once. Deliveries already queued are signed at the
   * moment they are attempted, so a rotation takes effect for everything still
   * in flight — the customer deploys the new secret first, then rotates.
   */
  async rotateSecret(endpointId: string) {
    await this.load(endpointId);
    const secret = newSecret();
    const endpoint = await this.prisma.db.webhookEndpoint.update({
      where: { id: endpointId },
      data: { secret: this.crypto.encrypt(secret) },
    });
    await this.audit.record({
      action: 'webhook.secret_rotated',
      resourceType: 'webhook_endpoint',
      resourceId: endpointId,
    });
    return { ...this.redact(endpoint), secret };
  }

  async remove(endpointId: string): Promise<void> {
    await this.load(endpointId);
    await this.prisma.db.webhookEndpoint.delete({ where: { id: endpointId } });
    await this.audit.record({
      action: 'webhook.deleted',
      resourceType: 'webhook_endpoint',
      resourceId: endpointId,
    });
  }

  /** The event types an endpoint may subscribe to, for a configuration screen. */
  catalogue(): { type: string; group: string }[] {
    return Object.values(DomainEvent)
      .map((type) => ({ type, group: type.split('.')[0] }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  // ── Delivery history ───────────────────────────────────────────────────────

  async deliveries(options: { endpointId?: string; status?: 'delivered' | 'pending' | 'failed'; limit?: number } = {}) {
    const where: Prisma.WebhookDeliveryWhereInput = {};
    if (options.endpointId) {
      await this.load(options.endpointId);
      where.endpointId = options.endpointId;
    }
    if (options.status === 'delivered') where.deliveredAt = { not: null };
    if (options.status === 'pending') {
      where.deliveredAt = null;
      where.attempts = { lt: MAX_ATTEMPTS };
    }
    if (options.status === 'failed') {
      where.deliveredAt = null;
      where.attempts = { gte: MAX_ATTEMPTS };
    }

    return this.prisma.db.webhookDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 50, 200),
      select: {
        id: true,
        endpointId: true,
        eventId: true,
        eventType: true,
        attempts: true,
        statusCode: true,
        error: true,
        deliveredAt: true,
        nextAttemptAt: true,
        createdAt: true,
      },
    });
  }

  async delivery(deliveryId: string) {
    const delivery = await this.prisma.db.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) throw AppError.notFound('Webhook delivery', deliveryId);
    return delivery;
  }

  /**
   * Re-send a delivery on request.
   *
   * A new row rather than a reset of the old one: the history of what was
   * attempted and when is the reason the history exists, and a replay that
   * overwrites it destroys the evidence somebody is replaying it to inspect.
   */
  async replay(deliveryId: string) {
    const original = await this.delivery(deliveryId);
    const endpoint = await this.load(original.endpointId);
    if (!endpoint.isActive) throw AppError.badRequest('That endpoint is disabled');

    const replayed = await this.prisma.db.webhookDelivery.create({
      data: {
        id: newId('delivery'),
        organizationId: original.organizationId,
        endpointId: original.endpointId,
        eventId: original.eventId,
        eventType: original.eventType,
        payload: original.payload as Prisma.InputJsonValue,
        nextAttemptAt: new Date(),
      },
    });

    const outcome = await this.attempt(replayed.id);
    return { deliveryId: replayed.id, ...outcome };
  }

  /**
   * Send a synthetic event so a customer can confirm their handler works before
   * anything real depends on it. Not recorded as a delivery: a test ping in the
   * history is a support ticket asking why an event nobody subscribed to fired.
   */
  async ping(endpointId: string) {
    const endpoint = await this.load(endpointId);
    const payload: WebhookPayload = {
      id: newId('outbox'),
      type: 'ping',
      createdAt: new Date().toISOString(),
      organizationId: endpoint.organizationId,
      data: { message: 'If you can read this, your endpoint is reachable and your secret verifies.' },
    };
    return this.post(endpoint, payload, 'ping', payload.id);
  }

  // ── Fan-out ────────────────────────────────────────────────────────────────

  /**
   * Queue an event for every endpoint subscribed to it, and attempt each
   * immediately.
   *
   * The rows are written before any request is made, so a process that dies
   * mid-fan-out leaves work the retry sweep will finish rather than events that
   * silently never went anywhere.
   */
  async dispatch(envelope: DomainEventEnvelope): Promise<number> {
    const endpoints = await this.prisma.raw.webhookEndpoint.findMany({
      where: { organizationId: envelope.organizationId, isActive: true },
    });
    const subscribed = endpoints.filter((endpoint) => matchesEvent(endpoint.events, envelope.type));
    if (!subscribed.length) return 0;

    const payload: WebhookPayload = {
      id: envelope.id,
      type: envelope.type,
      createdAt: envelope.occurredAt,
      organizationId: envelope.organizationId,
      data: envelope.data,
    };

    const created = await this.prisma.raw.webhookDelivery.createManyAndReturn({
      data: subscribed.map((endpoint) => ({
        id: newId('delivery'),
        organizationId: envelope.organizationId,
        endpointId: endpoint.id,
        eventId: envelope.id,
        eventType: envelope.type,
        payload: payload as unknown as Prisma.InputJsonValue,
        nextAttemptAt: new Date(),
      })),
      select: { id: true },
    });

    for (const row of created) {
      // Deliberately not awaited: a customer's slow endpoint must not add its
      // latency to the request that produced the event. A failure here leaves
      // the row for the sweep, which is exactly what the row is for.
      void this.attempt(row.id).catch((error) =>
        this.logger.error('Webhook delivery attempt failed', error, { deliveryId: row.id }),
      );
    }
    return created.length;
  }

  // ── Attempting ─────────────────────────────────────────────────────────────

  /** Deliveries whose backoff has elapsed. Called by the worker tier. */
  async retryDue(limit = 100): Promise<number> {
    const due = await this.prisma.raw.webhookDelivery.findMany({
      where: {
        deliveredAt: null,
        nextAttemptAt: { lte: new Date() },
        attempts: { lt: MAX_ATTEMPTS },
        endpoint: { isActive: true },
      },
      select: { id: true },
      take: limit,
    });

    let delivered = 0;
    for (const row of due) {
      const outcome = await this.attempt(row.id).catch((error) => {
        this.logger.error('Webhook retry failed', error, { deliveryId: row.id });
        return { delivered: false };
      });
      if (outcome.delivered) delivered += 1;
    }
    return delivered;
  }

  /**
   * One attempt at one delivery, recording the outcome either way.
   *
   * The single place a webhook is ever sent from. The request path and the
   * retry sweep both come through here so that backoff, failure counting and
   * auto-disable cannot drift apart between them.
   */
  async attempt(deliveryId: string): Promise<{ delivered: boolean; statusCode?: number; error?: string }> {
    const delivery = await this.prisma.raw.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: true },
    });
    if (!delivery) throw AppError.notFound('Webhook delivery', deliveryId);
    if (delivery.deliveredAt) return { delivered: true, statusCode: delivery.statusCode ?? undefined };
    if (!delivery.endpoint.isActive) return { delivered: false, error: 'endpoint is disabled' };

    const attempts = delivery.attempts + 1;
    const result = await this.post(
      delivery.endpoint,
      delivery.payload as unknown as WebhookPayload,
      delivery.eventType,
      delivery.id,
    );

    if (result.delivered) {
      await this.prisma.raw.$transaction([
        this.prisma.raw.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            attempts,
            deliveredAt: new Date(),
            statusCode: result.statusCode ?? null,
            responseBody: result.body ?? null,
            error: null,
            nextAttemptAt: null,
          },
        }),
        this.prisma.raw.webhookEndpoint.update({
          where: { id: delivery.endpointId },
          data: { failureCount: 0 },
        }),
      ]);
      return { delivered: true, statusCode: result.statusCode };
    }

    const exhausted = attempts >= MAX_ATTEMPTS;
    await this.prisma.raw.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts,
        statusCode: result.statusCode ?? null,
        responseBody: result.body ?? null,
        error: result.error?.slice(0, 300) ?? null,
        // Cleared once the budget is spent so the sweep stops selecting it.
        nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffMinutes(attempts) * 60_000),
      },
    });

    const endpoint = await this.prisma.raw.webhookEndpoint.update({
      where: { id: delivery.endpointId },
      data: { failureCount: { increment: 1 } },
    });
    if (endpoint.failureCount >= FAILURES_BEFORE_DISABLE && endpoint.isActive) {
      await this.disable(endpoint, result.error ?? `HTTP ${result.statusCode}`);
    }
    return { delivered: false, statusCode: result.statusCode, error: result.error };
  }

  private async disable(endpoint: WebhookEndpoint, reason: string): Promise<void> {
    await this.prisma.raw.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { isActive: false, disabledAt: new Date() },
    });
    this.logger.warn('Webhook endpoint retired after sustained failures', {
      endpointId: endpoint.id,
      failureCount: endpoint.failureCount,
      reason,
    });
    await this.audit.record({
      action: 'webhook.disabled',
      resourceType: 'webhook_endpoint',
      resourceId: endpoint.id,
      organizationId: endpoint.organizationId,
      after: { reason, failureCount: endpoint.failureCount },
    });

    // The whole failure mode this protects against is an integration that
    // stopped working without anybody noticing. Retiring it silently would
    // make that permanent instead of merely embarrassing.
    await this.notifyOwners(endpoint, reason);
  }

  private async notifyOwners(endpoint: WebhookEndpoint, reason: string): Promise<void> {
    try {
      const administrators = await this.prisma.raw.membership.findMany({
        where: {
          organizationId: endpoint.organizationId,
          // An invitation that was never accepted has no inbox to notify.
          acceptedAt: { not: null },
          role: { key: { in: ['owner', 'administrator'] } },
        },
        select: { userId: true },
      });
      if (!administrators.length) return;

      // The sweep runs with no tenant in scope, and the notification is written
      // per-tenant, so the organization has to be established explicitly.
      await RequestContextStore.runAsSystem(
        () =>
          this.notifications.notify({
            event: 'webhook.disabled',
            title: `Webhook endpoint "${endpoint.name}" was disabled`,
            body:
              `${FAILURES_BEFORE_DISABLE} deliveries in a row failed (${reason}). ` +
              'No events are being sent to it. Fix the endpoint and re-enable it to resume.',
            link: `/settings/webhooks/${endpoint.id}`,
            data: { endpointId: endpoint.id, url: endpoint.url, reason },
            userIds: administrators.map((membership) => membership.userId),
          }),
        endpoint.organizationId,
      );
    } catch (error) {
      // Failing to raise the alarm must not stop the endpoint being retired.
      this.logger.error('Could not notify anyone that a webhook was disabled', error, {
        endpointId: endpoint.id,
      });
    }
  }

  /** The HTTP request itself. Never throws — a transport failure is an outcome. */
  private async post(
    endpoint: WebhookEndpoint,
    payload: WebhookPayload,
    eventType: string,
    deliveryId: string,
  ): Promise<{ delivered: boolean; statusCode?: number; body?: string; error?: string }> {
    const reachable = this.reachable(endpoint.url);
    if (!reachable.allowed) return { delivered: false, error: `blocked: ${reachable.reason}` };

    let secret: string;
    try {
      secret = this.crypto.decrypt(endpoint.secret);
    } catch (error) {
      this.logger.error('Could not decrypt a webhook secret', error, { endpointId: endpoint.id });
      return { delivered: false, error: 'signing secret could not be read' };
    }

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Atrrehub-Webhooks/1.0',
          [EVENT_HEADER]: eventType,
          [DELIVERY_HEADER]: deliveryId,
          [SIGNATURE_HEADER]: signatureHeader(secret, timestamp, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const excerpt = await response
        .text()
        .then((text) => text.slice(0, RESPONSE_EXCERPT_LIMIT))
        .catch(() => undefined);

      if (response.ok) return { delivered: true, statusCode: response.status, body: excerpt };
      return {
        delivered: false,
        statusCode: response.status,
        body: excerpt,
        error: `endpoint responded ${response.status}`,
      };
    } catch (error) {
      return {
        delivered: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async load(endpointId: string): Promise<WebhookEndpoint> {
    const endpoint = await this.prisma.db.webhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint) throw AppError.notFound('Webhook endpoint', endpointId);
    return endpoint;
  }

  private assertUrl(url: string): void {
    const reachable = this.reachable(url);
    if (!reachable.allowed) throw AppError.badRequest(`That URL cannot be used: ${reachable.reason}`);
  }

  /**
   * Whether the platform may send a customer's data to this URL.
   *
   * In production the rule is the tool egress guard's, because a webhook URL is
   * tenant-supplied and the guard exists to stop a tenant pointing the platform
   * at the cluster it runs in — plus HTTPS, because the payload carries
   * customer data across somebody else's network.
   *
   * Outside production both are relaxed, and deliberately: a developer running
   * the platform locally has to be able to receive a webhook on their own
   * machine, and a rule that makes the feature untestable until it is in front
   * of customers is a rule that gets its first real exercise in front of
   * customers.
   */
  private reachable(url: string): { allowed: boolean; reason?: string } {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: 'the URL is malformed' };
    }
    if (!this.config.get('isProduction', { infer: true })) {
      return ['http:', 'https:'].includes(parsed.protocol)
        ? { allowed: true }
        : { allowed: false, reason: `protocol ${parsed.protocol} is not supported` };
    }

    const egress = isEgressAllowed(url);
    if (!egress.allowed) return egress;
    if (parsed.protocol !== 'https:') {
      return { allowed: false, reason: 'webhooks must be HTTPS — the payload carries customer data' };
    }
    return { allowed: true };
  }

  private assertEvents(events: string[]): string[] {
    if (!events.length) {
      throw AppError.badRequest('Subscribe to at least one event, or the endpoint receives nothing');
    }
    const invalid = events.filter((event) => !isValidSubscription(event));
    if (invalid.length) {
      throw AppError.badRequest(`Not valid event subscriptions: ${invalid.join(', ')}`);
    }
    return [...new Set(events)];
  }

  /** The secret never leaves the service except at creation and rotation. */
  private redact(endpoint: WebhookEndpoint) {
    const { secret: _secret, ...rest } = endpoint;
    return { ...rest, secretSet: true };
  }
}
