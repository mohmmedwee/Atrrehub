import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { initialState, step, validateIvr, type IvrDefinition } from './ivr';

export interface PhoneNumberInput {
  number: string;
  label?: string;
  provider: string;
  routeType: string;
  routeId?: string;
  afterHoursRouteType?: string;
  afterHoursRouteId?: string;
  businessHoursId?: string;
  recordCalls?: boolean;
  channelAccountId?: string;
  workspaceId?: string;
  capabilities?: string[];
}

export interface IvrFlowInput {
  name: string;
  description?: string;
  locale?: string;
  definition: IvrDefinition;
}

/** Phone numbers and IVR flows: everything about voice that is configuration. */
@Injectable()
export class IvrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Numbers ────────────────────────────────────────────────────────────────

  async listNumbers() {
    return this.prisma.db.phoneNumber.findMany({ orderBy: { number: 'asc' } });
  }

  async createNumber(input: PhoneNumberInput) {
    await this.assertRouteExists(input.routeType, input.routeId);
    if (input.afterHoursRouteType)
      await this.assertRouteExists(input.afterHoursRouteType, input.afterHoursRouteId);

    const clash = await this.prisma.db.phoneNumber.findFirst({
      where: { number: input.number },
      select: { id: true },
    });
    if (clash) throw AppError.conflict(`${input.number} is already configured`);

    const created = await this.prisma.db.phoneNumber.create({
      data: {
        id: newId('phoneNumber'),
        organizationId: RequestContextStore.organizationId()!,
        workspaceId: input.workspaceId,
        number: input.number,
        label: input.label,
        provider: input.provider,
        routeType: input.routeType,
        routeId: input.routeId,
        afterHoursRouteType: input.afterHoursRouteType,
        afterHoursRouteId: input.afterHoursRouteId,
        businessHoursId: input.businessHoursId,
        recordCalls: input.recordCalls ?? false,
        channelAccountId: input.channelAccountId,
        capabilities: input.capabilities ?? ['voice'],
      },
    });

    await this.audit.record({
      action: 'voice.number_added',
      resourceType: 'phone_number',
      resourceId: created.id,
      after: { number: input.number, routeType: input.routeType },
    });
    return created;
  }

  async updateNumber(numberId: string, patch: Partial<PhoneNumberInput>) {
    await this.getNumber(numberId);
    if (patch.routeType) await this.assertRouteExists(patch.routeType, patch.routeId);
    if (patch.afterHoursRouteType)
      await this.assertRouteExists(patch.afterHoursRouteType, patch.afterHoursRouteId);

    return this.prisma.db.phoneNumber.update({
      where: { id: numberId },
      data: {
        label: patch.label,
        routeType: patch.routeType,
        routeId: patch.routeId,
        afterHoursRouteType: patch.afterHoursRouteType,
        afterHoursRouteId: patch.afterHoursRouteId,
        businessHoursId: patch.businessHoursId,
        recordCalls: patch.recordCalls,
        channelAccountId: patch.channelAccountId,
      },
    });
  }

  async deleteNumber(numberId: string) {
    await this.getNumber(numberId);
    const live = await this.prisma.db.call.count({
      where: { phoneNumberId: numberId, endedAt: null },
    });
    if (live) throw AppError.conflict(`${live} call(s) are still live on this number`);

    await this.prisma.db.phoneNumber.delete({ where: { id: numberId } });
  }

  private async getNumber(numberId: string) {
    const number = await this.prisma.db.phoneNumber.findFirst({ where: { id: numberId } });
    if (!number) throw AppError.notFound('Phone number', numberId);
    return number;
  }

  /**
   * A route that points at nothing is a caller hearing dead air, so it is
   * refused at configuration time — the only moment anyone is watching.
   */
  private async assertRouteExists(routeType: string, routeId?: string | null) {
    if (routeType === 'voicemail') return;
    if (!routeId) throw AppError.badRequest(`A "${routeType}" route needs a target`);

    const exists = await (async () => {
      switch (routeType) {
        case 'ivr':
          return this.prisma.db.ivrFlow.findFirst({ where: { id: routeId }, select: { id: true } });
        case 'queue':
          return this.prisma.db.queue.findFirst({ where: { id: routeId }, select: { id: true } });
        case 'agent':
          return this.prisma.db.membership.findFirst({
            where: { userId: routeId },
            select: { id: true },
          });
        case 'ai_agent':
          return this.prisma.db.agent.findFirst({ where: { id: routeId }, select: { id: true } });
        default:
          return null;
      }
    })();

    if (!exists) throw AppError.badRequest(`No ${routeType} with id "${routeId}" exists here`);
  }

  // ── Flows ──────────────────────────────────────────────────────────────────

  async listFlows() {
    return this.prisma.db.ivrFlow.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  async getFlow(flowId: string) {
    const flow = await this.prisma.db.ivrFlow.findFirst({ where: { id: flowId } });
    if (!flow) throw AppError.notFound('IVR flow', flowId);
    return flow;
  }

  async createFlow(input: IvrFlowInput) {
    this.assertValid(input.definition);

    const clash = await this.prisma.db.ivrFlow.findFirst({
      where: { name: input.name },
      select: { id: true },
    });
    if (clash) throw AppError.conflict(`A flow named "${input.name}" already exists`);

    return this.prisma.db.ivrFlow.create({
      data: {
        id: newId('ivrFlow'),
        organizationId: RequestContextStore.organizationId()!,
        name: input.name,
        description: input.description,
        locale: input.locale ?? 'en',
        definition: input.definition as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async updateFlow(flowId: string, patch: Partial<IvrFlowInput>) {
    const flow = await this.getFlow(flowId);
    if (patch.definition) this.assertValid(patch.definition);

    return this.prisma.db.ivrFlow.update({
      where: { id: flowId },
      data: {
        name: patch.name,
        description: patch.description,
        locale: patch.locale,
        ...(patch.definition
          ? {
              definition: patch.definition as unknown as Prisma.InputJsonValue,
              version: flow.version + 1,
            }
          : {}),
      },
    });
  }

  /** Only one flow answers inbound calls, so activating one retires the rest. */
  async setActive(flowId: string, isActive: boolean) {
    const flow = await this.getFlow(flowId);
    if (isActive) this.assertValid(flow.definition as unknown as IvrDefinition);

    if (isActive)
      await this.prisma.db.ivrFlow.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });

    const updated = await this.prisma.db.ivrFlow.update({
      where: { id: flowId },
      data: { isActive },
    });
    await this.audit.record({
      action: isActive ? 'voice.ivr_activated' : 'voice.ivr_deactivated',
      resourceType: 'ivr_flow',
      resourceId: flowId,
    });
    return updated;
  }

  async deleteFlow(flowId: string) {
    const flow = await this.getFlow(flowId);
    if (flow.isActive) throw AppError.conflict('Deactivate the flow before deleting it');

    const routed = await this.prisma.db.phoneNumber.count({
      where: { OR: [{ routeId: flowId }, { afterHoursRouteId: flowId }] },
    });
    if (routed) throw AppError.conflict(`${routed} phone number(s) still route to this flow`);

    await this.prisma.db.ivrFlow.delete({ where: { id: flowId } });
  }

  /**
   * Walk a flow with a sequence of keypresses and report what a caller would
   * have heard. Building an IVR by phoning it repeatedly is the slowest
   * feedback loop in the product.
   */
  async simulate(flowId: string, digits: string[]) {
    const flow = await this.getFlow(flowId);
    const definition = flow.definition as unknown as IvrDefinition;
    this.assertValid(definition);

    const heard: string[] = [];
    let outcome = step(definition, initialState(definition));
    heard.push(...describe(outcome.actions));

    for (const entry of digits) {
      if (outcome.kind !== 'continue') break;
      outcome = step(definition, outcome.state, {
        digits: entry,
        timedOut: entry === '' || entry.toLowerCase() === 'timeout',
      });
      heard.push(...describe(outcome.actions));
    }

    return {
      outcome: outcome.kind,
      heard,
      path: outcome.state.path,
      collected: outcome.state.collected,
      ...(outcome.kind === 'queue' ? { queueId: outcome.queueId } : {}),
      ...(outcome.kind === 'agent' ? { userId: outcome.userId } : {}),
      ...(outcome.kind === 'ai_agent' ? { agentId: outcome.agentId } : {}),
      ...(outcome.kind === 'transfer' ? { to: outcome.to } : {}),
    };
  }

  private assertValid(definition: IvrDefinition) {
    const errors = validateIvr(definition);
    if (errors.length)
      throw AppError.badRequest(`This flow cannot be walked: ${errors.join('; ')}`);
  }
}

function describe(
  actions: { kind: string; text?: string; say?: string; queueId?: string }[],
): string[] {
  return actions
    .map((action) => action.text ?? action.say ?? (action.kind === 'enqueue' ? `(queued)` : null))
    .filter((line): line is string => Boolean(line));
}
