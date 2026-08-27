import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type DataPlaneStatus } from '@prisma/client';
import type { AppConfig } from '../../config/configuration';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { checkResidency, redactForTransit } from './residency';

/**
 * Hybrid deployment.
 *
 * A control plane operates; a data plane holds the data. The customer's
 * conversations, customers, messages and AI executions never leave their
 * infrastructure — what crosses the boundary is enrollment, configuration,
 * health and aggregate counts, and every payload that leaves is checked
 * against the residency guard first.
 *
 * `standalone` is the default and is a complete platform on its own: SaaS and
 * private cloud both run it, and neither pays for any of this.
 */

/** A plane silent for longer than this has stopped reporting. */
const HEARTBEAT_GRACE_MS = 3 * 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
export const CONTRACT_VERSION = '1.0';

export interface RegisterInput {
  name: string;
  region: string;
  organizationIds?: string[];
  config?: Record<string, unknown>;
}

@Injectable()
export class HybridService implements OnModuleInit {
  private startedAt = Date.now();

  constructor(
    private readonly config: ConfigService<AppConfig>,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    const deployment = this.mode();
    if (deployment !== 'standalone')
      this.logger.info('Hybrid deployment active', {
        mode: deployment,
        contractVersion: CONTRACT_VERSION,
      });
  }

  mode(): 'standalone' | 'control_plane' | 'data_plane' {
    return this.config.get('deployment', { infer: true })?.mode ?? 'standalone';
  }

  /** What this process is and what it will do, for an operator and a probe. */
  status() {
    const deployment = this.config.get('deployment', { infer: true });
    return {
      mode: this.mode(),
      contractVersion: CONTRACT_VERSION,
      region: deployment?.region ?? 'local',
      controlPlaneUrl: deployment?.controlPlaneUrl ?? null,
      enrolled: Boolean(deployment?.enrollmentToken),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  private assertControlPlane(): void {
    if (this.mode() !== 'control_plane')
      throw new AppError(
        'not_implemented',
        'This deployment is not a control plane; set DEPLOYMENT_MODE=control_plane to operate data planes',
      );
  }

  // ── Control plane ──────────────────────────────────────────────────────────

  /**
   * Register a data plane and issue its enrollment token.
   *
   * The token is shown once. Only its hash is stored, so a control plane
   * database that leaks does not hand an attacker the ability to impersonate
   * a customer's deployment.
   */
  async registerDataPlane(input: RegisterInput) {
    this.assertControlPlane();

    const clash = await this.prisma.raw.dataPlane.findFirst({
      where: { name: input.name },
      select: { id: true },
    });
    if (clash) throw AppError.conflict(`A data plane named "${input.name}" already exists`);

    // Configuration is distributed to a customer's infrastructure, so it is
    // held to the same standard as telemetry coming back.
    if (input.config) {
      const residency = checkResidency(input.config);
      if (!residency.allowed)
        throw AppError.badRequest(
          `That configuration cannot be distributed: ${residency.violations
            .map((violation) => `${violation.path} ${violation.detail}`)
            .join('; ')}`,
        );
    }

    const token = `dpt_${this.crypto.randomToken(32)}`;
    const plane = await this.prisma.raw.dataPlane.create({
      data: {
        id: newId('dataPlane'),
        name: input.name,
        region: input.region,
        enrollmentTokenHash: this.crypto.hashToken(token),
        organizationIds: input.organizationIds ?? [],
        config: (input.config ?? {}) as Prisma.InputJsonValue,
      },
    });

    await this.audit.record({
      action: 'hybrid.data_plane_registered',
      resourceType: 'data_plane',
      resourceId: plane.id,
      after: { name: input.name, region: input.region },
    });

    return {
      ...this.redact(plane),
      enrollmentToken: token,
      note: 'This token is shown once. Configure it on the data plane now.',
    };
  }

  async listDataPlanes() {
    this.assertControlPlane();
    const planes = await this.prisma.raw.dataPlane.findMany({ orderBy: { createdAt: 'desc' } });
    return planes.map((plane) => ({
      ...this.redact(plane),
      // Derived rather than stored: a plane that stopped reporting never gets
      // the chance to write "unreachable" about itself.
      live: this.isLive(plane.lastHeartbeatAt),
    }));
  }

  async getDataPlane(planeId: string) {
    this.assertControlPlane();
    const plane = await this.prisma.raw.dataPlane.findFirst({
      where: { id: planeId },
      include: { heartbeats: { orderBy: { reportedAt: 'desc' }, take: 20 } },
    });
    if (!plane) throw AppError.notFound('Data plane', planeId);
    return { ...this.redact(plane), live: this.isLive(plane.lastHeartbeatAt) };
  }

  /** Update the configuration a plane will pull on its next heartbeat. */
  async updateConfig(planeId: string, config: Record<string, unknown>) {
    this.assertControlPlane();
    const plane = await this.prisma.raw.dataPlane.findFirst({ where: { id: planeId } });
    if (!plane) throw AppError.notFound('Data plane', planeId);

    const residency = checkResidency(config);
    if (!residency.allowed)
      throw AppError.badRequest(
        `That configuration cannot be distributed: ${residency.violations
          .map((violation) => `${violation.path} ${violation.detail}`)
          .join('; ')}`,
      );

    const updated = await this.prisma.raw.dataPlane.update({
      where: { id: planeId },
      data: { config: config as Prisma.InputJsonValue, configVersion: plane.configVersion + 1 },
    });
    return this.redact(updated);
  }

  async suspendDataPlane(planeId: string, suspended: boolean) {
    this.assertControlPlane();
    const plane = await this.prisma.raw.dataPlane.update({
      where: { id: planeId },
      data: { status: suspended ? 'suspended' : 'pending' },
    });
    await this.audit.record({
      action: suspended ? 'hybrid.data_plane_suspended' : 'hybrid.data_plane_resumed',
      resourceType: 'data_plane',
      resourceId: planeId,
    });
    return this.redact(plane);
  }

  /**
   * Accept a heartbeat from a data plane.
   *
   * The residency guard runs here as well as on the sending side. A control
   * plane cannot assume the thing calling it is a well-behaved data plane —
   * it may be an older build, a misconfigured one, or not a data plane at all
   * — and accepting customer content by accident is precisely the failure this
   * whole architecture exists to prevent.
   */
  async receiveHeartbeat(
    token: string,
    payload: { version?: string; status?: string; uptimeSeconds?: number; metrics?: unknown },
  ) {
    this.assertControlPlane();

    const plane = await this.prisma.raw.dataPlane.findUnique({
      where: { enrollmentTokenHash: this.crypto.hashToken(token) },
    });
    if (!plane) throw AppError.unauthenticated('That enrollment token is not valid');
    if (plane.status === 'suspended')
      throw AppError.permissionDenied('hybrid:data_plane_suspended');

    const metrics = payload.metrics ?? {};
    const residency = checkResidency(metrics);
    if (!residency.allowed) {
      this.logger.error('A data plane sent a payload carrying customer data', undefined, {
        dataPlaneId: plane.id,
        violations: residency.violations.slice(0, 5),
      });
      throw AppError.badRequest(
        `Refused: telemetry must not carry customer data — ${residency.violations
          .map((violation) => `${violation.path} ${violation.detail}`)
          .join('; ')}`,
      );
    }

    const now = new Date();
    const status: DataPlaneStatus = payload.status === 'degraded' ? 'degraded' : 'healthy';

    await this.prisma.raw.$transaction([
      this.prisma.raw.dataPlaneHeartbeat.create({
        data: {
          id: newId('heartbeat'),
          dataPlaneId: plane.id,
          version: payload.version,
          status,
          uptimeSeconds: payload.uptimeSeconds,
          metrics: metrics as Prisma.InputJsonValue,
          reportedAt: now,
        },
      }),
      this.prisma.raw.dataPlane.update({
        where: { id: plane.id },
        data: {
          status,
          version: payload.version,
          contractVersion: CONTRACT_VERSION,
          lastHeartbeatAt: now,
          enrolledAt: plane.enrolledAt ?? now,
        },
      }),
    ]);

    // The response is the plane's next instruction: pull config if it changed.
    return {
      acknowledged: true,
      configVersion: plane.configVersion,
      config: plane.config,
      contractVersion: CONTRACT_VERSION,
      nextHeartbeatMs: HEARTBEAT_INTERVAL_MS,
    };
  }

  /** Mark planes that have gone quiet. Called by the worker tier. */
  async sweepUnreachable(): Promise<number> {
    if (this.mode() !== 'control_plane') return 0;

    const cutoff = new Date(Date.now() - HEARTBEAT_GRACE_MS);
    const result = await this.prisma.raw.dataPlane.updateMany({
      where: {
        status: { in: ['healthy', 'degraded'] },
        OR: [{ lastHeartbeatAt: { lt: cutoff } }, { lastHeartbeatAt: null }],
      },
      data: { status: 'unreachable' },
    });

    if (result.count) this.logger.warn('Data planes stopped reporting', { planes: result.count });
    return result.count;
  }

  // ── Data plane ─────────────────────────────────────────────────────────────

  /**
   * Report to the control plane.
   *
   * Everything is redacted and then *checked* before it is sent: redaction
   * alone would silently drop a field, and a silent drop is how a residency
   * bug survives a release. The check is what turns it into a loud failure.
   */
  async sendHeartbeat(): Promise<{ sent: boolean; reason?: string; configVersion?: number }> {
    const deployment = this.config.get('deployment', { infer: true });
    if (this.mode() !== 'data_plane') return { sent: false, reason: 'not a data plane' };
    if (!deployment?.controlPlaneUrl || !deployment.enrollmentToken)
      return { sent: false, reason: 'no control plane configured' };

    const reachable = this.controlPlaneReachable(deployment.controlPlaneUrl);
    if (!reachable.allowed) return { sent: false, reason: reachable.reason };

    const payload = {
      version: process.env.npm_package_version ?? 'unknown',
      status: 'healthy',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      metrics: await this.collectMetrics(),
    };

    const residency = checkResidency(payload.metrics);
    if (!residency.allowed) {
      // Refusing to send is the correct failure: losing telemetry is an
      // inconvenience, sending a customer's data across a border is not.
      this.logger.error('Refusing to send telemetry that carries customer data', undefined, {
        violations: residency.violations.slice(0, 5),
      });
      return { sent: false, reason: 'telemetry failed the residency check' };
    }

    try {
      const response = await fetch(
        `${deployment.controlPlaneUrl.replace(/\/+$/, '')}/api/v1/hybrid/heartbeat`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${deployment.enrollmentToken}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!response.ok) return { sent: false, reason: `control plane returned ${response.status}` };

      const body = (await response.json()) as { data?: { configVersion?: number } };
      return { sent: true, configVersion: body.data?.configVersion };
    } catch (error) {
      this.logger.warn('Could not reach the control plane', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { sent: false, reason: 'control plane unreachable' };
    }
  }

  /**
   * Aggregate counts for the reporting window.
   *
   * Counts only, and passed through the redactor before it is returned, so a
   * future edit here cannot put a subject line on the wire even by accident.
   */
  private async collectMetrics(): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - 3_600_000);

    const [organizations, users, conversations, messages, executions] = await Promise.all([
      this.prisma.raw.organization.count(),
      this.prisma.raw.user.count(),
      this.prisma.raw.conversation.count({ where: { createdAt: { gte: since } } }),
      this.prisma.raw.message.count({ where: { createdAt: { gte: since } } }),
      this.prisma.raw.execution.count({ where: { createdAt: { gte: since } } }),
    ]);

    return redactForTransit({
      periodStart: since.toISOString(),
      periodEnd: new Date().toISOString(),
      organizations,
      users,
      conversations,
      messages,
      executions,
    }) as Record<string, unknown>;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Whether the configured control plane may be called.
   *
   * Deliberately *not* the tool egress guard. That guard refuses every private
   * address, which is right for a URL a tenant supplied — it stops them
   * pointing the platform at the cluster. A control plane URL is operator
   * configuration, and a perfectly ordinary on-premise deployment has its
   * control plane at 10.x. So the rule here is narrower and aimed at the thing
   * that is never legitimate: the cloud metadata endpoint, and cleartext in
   * production.
   */
  private controlPlaneReachable(url: string): { allowed: boolean; reason?: string } {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: 'the control plane URL is malformed' };
    }

    if (!['http:', 'https:'].includes(parsed.protocol))
      return { allowed: false, reason: `protocol ${parsed.protocol} is not supported` };

    // 169.254.169.254 and its neighbours are never a control plane, and a
    // misconfiguration that points telemetry at them leaks instance
    // credentials to whatever answers.
    if (parsed.hostname.startsWith('169.254.'))
      return { allowed: false, reason: 'link-local addresses are not a control plane' };

    if (this.config.get('isProduction', { infer: true }) && parsed.protocol !== 'https:')
      return { allowed: false, reason: 'telemetry must not cross a network in cleartext' };

    return { allowed: true };
  }

  private isLive(lastHeartbeatAt: Date | null): boolean {
    return Boolean(lastHeartbeatAt && Date.now() - lastHeartbeatAt.getTime() < HEARTBEAT_GRACE_MS);
  }

  /** The token hash never leaves the service. */
  private redact<T extends { enrollmentTokenHash: string }>(plane: T) {
    const { enrollmentTokenHash: _hash, ...rest } = plane;
    return rest;
  }
}
