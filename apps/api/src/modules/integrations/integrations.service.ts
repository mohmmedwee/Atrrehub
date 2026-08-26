import { Injectable } from '@nestjs/common';
import { Prisma, type IntegrationKind } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CustomersService } from '../customers/customers.service';
import { isEgressAllowed } from '../guardrails/detectors';
import {
  MAPPABLE_FIELDS,
  PRESETS,
  buildRequest,
  mapRecord,
  readPath,
  type ConnectorConfig,
  type MappableField,
} from './connectors';

export interface IntegrationInput {
  kind: IntegrationKind;
  name: string;
  credentials?: Record<string, string>;
  config?: Partial<ConnectorConfig>;
  fieldMapping?: Record<string, string>;
  workspaceId?: string;
}

export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  pages: number;
  errors: string[];
}

/** One sync is a scheduled job's worth of work, not an unbounded backfill. */
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly customers: CustomersService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  /** The providers on offer, and what each needs, for a connect screen. */
  catalogue() {
    return Object.entries(PRESETS).map(([key, preset]) => ({
      kind: key,
      label: preset.label,
      credentials: preset.credentials,
      config: preset.config,
      fieldMapping: preset.fieldMapping,
      mappableFields: MAPPABLE_FIELDS,
    }));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async list() {
    const integrations = await this.prisma.db.integration.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return integrations.map((integration) => this.redact(integration));
  }

  async get(integrationId: string) {
    const integration = await this.load(integrationId);
    return this.redact(integration);
  }

  /**
   * Connect. The integration starts `disconnected`: credentials are stored but
   * unproven, and nothing syncs until a test has actually reached the provider.
   */
  async create(input: IntegrationInput) {
    const preset = PRESETS[input.kind] ?? PRESETS.rest;
    const config = { ...preset.config, ...input.config } as ConnectorConfig;
    this.validateConfig(config, input.credentials ?? {});
    this.validateMapping(input.fieldMapping ?? preset.fieldMapping);

    const organizationId = RequestContextStore.organizationId()!;
    const integration = await this.prisma.db.integration.create({
      data: {
        id: newId('integration'),
        organizationId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        name: input.name,
        credentials: this.crypto.encryptObject(input.credentials ?? {}) as Prisma.InputJsonValue,
        config: config as unknown as Prisma.InputJsonValue,
        fieldMapping: (input.fieldMapping ?? preset.fieldMapping) as Prisma.InputJsonValue,
        status: 'disconnected',
        isActive: false,
      },
    });

    await this.audit.record({
      action: 'integration.created',
      resourceType: 'integration',
      resourceId: integration.id,
      after: { kind: input.kind, name: input.name },
    });

    return this.redact(integration);
  }

  async update(integrationId: string, patch: Partial<IntegrationInput>) {
    const existing = await this.load(integrationId);

    const config = patch.config
      ? ({ ...(existing.config as object), ...patch.config } as ConnectorConfig)
      : (existing.config as unknown as ConnectorConfig);
    const credentials = patch.credentials
      ? { ...this.credentialsOf(existing), ...patch.credentials }
      : this.credentialsOf(existing);

    if (patch.config || patch.credentials) this.validateConfig(config, credentials);
    if (patch.fieldMapping) this.validateMapping(patch.fieldMapping);

    const updated = await this.prisma.db.integration.update({
      where: { id: integrationId },
      data: {
        name: patch.name,
        config: config as unknown as Prisma.InputJsonValue,
        ...(patch.credentials
          ? { credentials: this.crypto.encryptObject(credentials) as Prisma.InputJsonValue }
          : {}),
        ...(patch.fieldMapping
          ? { fieldMapping: patch.fieldMapping as Prisma.InputJsonValue }
          : {}),
        // Changing how it connects invalidates the last successful test.
        ...(patch.config || patch.credentials
          ? { status: 'disconnected', isActive: false, lastError: null }
          : {}),
      },
    });

    return this.redact(updated);
  }

  async delete(integrationId: string) {
    await this.load(integrationId);
    await this.prisma.db.integration.delete({ where: { id: integrationId } });
    await this.audit.record({
      action: 'integration.deleted',
      resourceType: 'integration',
      resourceId: integrationId,
    });
  }

  /**
   * Test the connection by fetching one page and reporting what came back.
   *
   * The result includes a sample of the field names the provider actually
   * returned, because the usual reason a sync produces nothing is a field map
   * written against documentation rather than against the live payload.
   */
  async test(integrationId: string) {
    const integration = await this.load(integrationId);
    const config = integration.config as unknown as ConnectorConfig;
    const started = Date.now();

    try {
      const page = await this.fetchPage(config, this.credentialsOf(integration));
      const sample = page.records[0] ?? {};

      await this.prisma.db.integration.update({
        where: { id: integrationId },
        data: { status: 'connected', lastError: null },
      });

      return {
        ok: true,
        status: 'connected',
        durationMs: Date.now() - started,
        recordsOnFirstPage: page.records.length,
        availableFields: this.leafPaths(sample).slice(0, 50),
        mappedFields: Object.keys(integration.fieldMapping as object),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.db.integration.update({
        where: { id: integrationId },
        data: { status: 'error', lastError: message.slice(0, 500), isActive: false },
      });
      return { ok: false, status: 'error', durationMs: Date.now() - started, error: message };
    }
  }

  /** Enabling requires a proven connection — an untested integration cannot sync. */
  async setActive(integrationId: string, isActive: boolean) {
    const integration = await this.load(integrationId);
    if (isActive && integration.status !== 'connected')
      throw AppError.conflict(
        'Test the connection before enabling it — an integration that has never reached the provider cannot sync',
      );

    const updated = await this.prisma.db.integration.update({
      where: { id: integrationId },
      data: { isActive },
    });
    await this.audit.record({
      action: isActive ? 'integration.enabled' : 'integration.disabled',
      resourceType: 'integration',
      resourceId: integrationId,
    });
    return this.redact(updated);
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  /**
   * Pull contacts and reconcile them into Customer 360.
   *
   * A record is matched on its email or phone, so a contact already known from
   * a conversation is enriched rather than duplicated. Records the map yields
   * no contact for are skipped and counted: importing a nameless, contactless
   * row would create a customer nobody can ever reach or merge.
   */
  async sync(integrationId: string): Promise<SyncResult> {
    const integration = await this.load(integrationId);
    if (!integration.isActive) throw AppError.conflict('This integration is not enabled');

    const config = integration.config as unknown as ConnectorConfig;
    const mapping = integration.fieldMapping as Record<string, string>;
    const credentials = this.credentialsOf(integration);

    const result: SyncResult = {
      fetched: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      pages: 0,
      errors: [],
    };
    let cursor: string | undefined;

    try {
      do {
        const page = await this.fetchPage(config, credentials, cursor);
        result.pages += 1;
        result.fetched += page.records.length;

        for (const record of page.records) {
          try {
            const outcome = await this.upsertCustomer(record, mapping);
            if (outcome === 'created') result.created += 1;
            else if (outcome === 'updated') result.updated += 1;
            else result.skipped += 1;
          } catch (error) {
            // One malformed record must not abandon the rest of the page.
            result.skipped += 1;
            if (result.errors.length < 10)
              result.errors.push(error instanceof Error ? error.message : String(error));
          }
        }

        cursor = page.cursor;
      } while (cursor && result.pages < MAX_PAGES);

      await this.prisma.db.integration.update({
        where: { id: integrationId },
        data: { lastSyncAt: new Date(), status: 'connected', lastError: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.db.integration.update({
        where: { id: integrationId },
        data: { status: 'error', lastError: message.slice(0, 500) },
      });
      throw AppError.dependency(integration.name, message);
    }

    this.logger.info('Integration sync finished', { integrationId, ...result });
    return result;
  }

  /** Sync every enabled integration. Called by the worker tier. */
  async syncDue(): Promise<number> {
    const integrations = await this.prisma.raw.integration.findMany({
      where: { isActive: true, status: 'connected' },
      select: { id: true, organizationId: true },
      take: 100,
    });

    let synced = 0;
    for (const integration of integrations) {
      try {
        await RequestContextStore.runAsSystem(
          () => this.sync(integration.id),
          integration.organizationId,
        );
        synced += 1;
      } catch (error) {
        this.logger.error('Scheduled integration sync failed', error, {
          integrationId: integration.id,
        });
      }
    }
    return synced;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async upsertCustomer(
    record: Record<string, unknown>,
    mapping: Record<string, string>,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const mapped = mapRecord(record, mapping);
    const { email, phone, ...profile } = mapped as Record<MappableField, string | undefined>;

    const contact = email
      ? { kind: 'email' as const, value: email }
      : phone
        ? { kind: 'phone' as const, value: phone }
        : null;
    if (!contact) return 'skipped';

    const seed = Object.fromEntries(
      Object.entries(profile).filter(([, value]) => value !== undefined),
    );

    const { customer, created } = await this.customers.findOrCreateByContact(
      contact.kind,
      contact.value,
      seed,
    );
    if (created) return 'created';

    // An existing customer is enriched, never overwritten: what an agent typed
    // during a conversation is better evidence than a stale CRM row.
    const fill = Object.fromEntries(
      Object.entries(seed).filter(
        ([key]) => !(customer as unknown as Record<string, unknown>)[key],
      ),
    );
    if (!Object.keys(fill).length) return 'skipped';

    await this.customers.update(customer.id, fill);
    return 'updated';
  }

  private async fetchPage(
    config: ConnectorConfig,
    credentials: Record<string, string>,
    cursor?: string,
  ): Promise<{ records: Record<string, unknown>[]; cursor?: string }> {
    const { url, headers } = buildRequest(config, credentials, cursor);

    // The same egress control the tools platform uses: a tenant-supplied base
    // URL is a server-side request, and must not be able to reach the cluster.
    const egress = isEgressAllowed(url);
    if (!egress.allowed) throw new Error(`Refusing to call ${url}: ${egress.reason}`);

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }

    const payload = (await response.json()) as unknown;
    const records = readPath(payload, config.recordsPath ?? '');
    if (!Array.isArray(records))
      throw new Error(
        `No array of records at "${config.recordsPath ?? '(root)'}" in the provider's response`,
      );

    const next = config.nextPath ? readPath(payload, config.nextPath) : undefined;
    return {
      records: records.filter(
        (record): record is Record<string, unknown> =>
          typeof record === 'object' && record !== null,
      ),
      cursor: typeof next === 'string' && next ? next : undefined,
    };
  }

  private async load(integrationId: string) {
    const integration = await this.prisma.db.integration.findFirst({
      where: { id: integrationId },
    });
    if (!integration) throw AppError.notFound('Integration', integrationId);
    return integration;
  }

  private credentialsOf(integration: { credentials: Prisma.JsonValue }): Record<string, string> {
    const decrypted = this.crypto.decryptObject(
      (integration.credentials ?? {}) as Record<string, unknown>,
    );
    return Object.fromEntries(
      Object.entries(decrypted).map(([key, value]) => [key, String(value ?? '')]),
    );
  }

  /** Credentials never leave the service — only which keys are set. */
  private redact<T extends { credentials: Prisma.JsonValue }>(integration: T) {
    const { credentials, ...rest } = integration;
    return {
      ...rest,
      credentialKeys: Object.keys((credentials ?? {}) as Record<string, unknown>),
    };
  }

  private validateConfig(config: ConnectorConfig, credentials: Record<string, string>): void {
    const base = credentials.instanceUrl || config.baseUrl;
    if (!base) throw AppError.badRequest('An integration needs a base URL');
    if (!config.contactsPath) throw AppError.badRequest('An integration needs a contacts path');

    const probe = `${base.replace(/\/+$/, '')}${config.contactsPath}`;
    const egress = isEgressAllowed(probe);
    if (!egress.allowed) throw AppError.badRequest(`That URL cannot be called: ${egress.reason}`);
  }

  private validateMapping(mapping: Record<string, string>): void {
    for (const [external, internal] of Object.entries(mapping)) {
      if (!(MAPPABLE_FIELDS as readonly string[]).includes(internal))
        throw AppError.badRequest(
          `"${external}" maps to "${internal}", which is not a customer field. Available: ${MAPPABLE_FIELDS.join(', ')}`,
        );
    }
  }

  /** Every leaf path of a sample record, so a field map can be written against reality. */
  private leafPaths(record: unknown, prefix = '', depth = 0): string[] {
    if (depth > 3 || record === null || typeof record !== 'object') return prefix ? [prefix] : [];
    if (Array.isArray(record)) return prefix ? [prefix] : [];

    return Object.entries(record).flatMap(([key, value]) =>
      this.leafPaths(value, prefix ? `${prefix}.${key}` : key, depth + 1),
    );
  }
}
