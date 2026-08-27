import { Injectable } from '@nestjs/common';
import { Prisma, type AgentPresence, type ChannelType } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { forecastAccuracy, forecastIntervals, type HistoricalInterval } from './forecast';
import { calculateStaffing, evaluateStaffing } from './staffing';

export interface ForecastInput {
  name: string;
  startsAt: Date;
  endsAt: Date;
  queueId?: string;
  channel?: ChannelType;
  intervalMinutes?: number;
  lookbackWeeks?: number;
  growthFactor?: number;
  shrinkage?: number;
  targetServiceLevel?: number;
  targetAnswerSec?: number;
  maxOccupancy?: number;
}

export interface ShiftInput {
  userId: string;
  startsAt: Date;
  endsAt: Date;
  templateId?: string;
  queueIds?: string[];
  breaks?: { startsAt: Date; endsAt: Date; paid?: boolean }[];
  note?: string;
}

/** Presence states that count as being on the line. */
const AVAILABLE_STATES: AgentPresence[] = ['available', 'busy'];

/** A forecast longer than this is a capacity plan, not an operational roster. */
const MAX_FORECAST_DAYS = 120;

@Injectable()
export class WfmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  // ── Forecasting ────────────────────────────────────────────────────────────

  /**
   * Build a forecast from the organization's own contact history, then size
   * every interval with Erlang C.
   *
   * History comes from conversations rather than a separate metrics table, so
   * a forecast is always drawn from what actually happened rather than from a
   * rollup that may have drifted.
   */
  async generateForecast(input: ForecastInput) {
    const organizationId = RequestContextStore.organizationId()!;
    const intervalMinutes = input.intervalMinutes ?? 30;

    if (input.startsAt >= input.endsAt)
      throw AppError.badRequest('A forecast window starts before it ends');
    const days = (input.endsAt.getTime() - input.startsAt.getTime()) / 86_400_000;
    if (days > MAX_FORECAST_DAYS)
      throw AppError.badRequest(`A forecast covers at most ${MAX_FORECAST_DAYS} days`);

    const clash = await this.prisma.db.forecast.findFirst({
      where: { name: input.name },
      select: { id: true },
    });
    if (clash) throw AppError.conflict(`A forecast named "${input.name}" already exists`);

    const lookbackWeeks = input.lookbackWeeks ?? 6;
    const history = await this.contactHistory({
      organizationId,
      since: new Date(input.startsAt.getTime() - lookbackWeeks * 7 * 86_400_000),
      until: input.startsAt,
      intervalMinutes,
      queueId: input.queueId,
      channel: input.channel,
    });

    const points = forecastIntervals(history, input.startsAt, input.endsAt, {
      lookbackWeeks,
      intervalMinutes,
      growthFactor: input.growthFactor,
    });

    const shrinkage = input.shrinkage ?? 0.3;
    const targetServiceLevel = input.targetServiceLevel ?? 0.8;
    const targetAnswerSec = input.targetAnswerSec ?? 20;
    const maxOccupancy = input.maxOccupancy ?? 0.85;
    const forecastId = newId('forecast');

    const intervalRows = points.map((point) => {
      const staffing = calculateStaffing({
        volume: point.volume,
        averageHandleTimeSec: point.averageHandleTimeSec,
        intervalSec: intervalMinutes * 60,
        targetServiceLevel,
        targetAnswerSec,
        shrinkage,
        maxOccupancy,
      });

      return {
        id: newId('forecastInterval'),
        organizationId,
        forecastId,
        startsAt: point.startsAt,
        predictedVolume: point.volume,
        averageHandleTimeSec: point.averageHandleTimeSec,
        requiredAgents: staffing.requiredAgents,
        rosteredAgents: staffing.rosteredAgents,
        serviceLevel: staffing.serviceLevel,
        occupancy: staffing.occupancy,
        confidence: point.confidence,
        samples: point.samples,
      };
    });

    // One transaction: a forecast whose intervals failed to write is an empty
    // shell that still holds its name, and the next attempt cannot reuse it.
    await this.prisma.raw.$transaction(async (tx) => {
      await tx.forecast.create({
        data: {
          id: forecastId,
          organizationId,
          name: input.name,
          queueId: input.queueId,
          channel: input.channel,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          intervalMinutes,
          lookbackWeeks,
          growthFactor: input.growthFactor ?? 1,
          shrinkage,
          targetServiceLevel,
          targetAnswerSec,
          maxOccupancy,
          createdById: RequestContextStore.principal()?.id,
        },
      });
      await tx.forecastInterval.createMany({ data: intervalRows });
    });

    this.logger.info('Forecast generated', {
      forecastId,
      intervals: points.length,
      blind: points.filter((point) => point.confidence === 0).length,
    });

    return this.getForecast(forecastId);
  }

  async listForecasts() {
    return this.prisma.db.forecast.findMany({
      orderBy: { startsAt: 'desc' },
      include: { _count: { select: { intervals: true } } },
    });
  }

  async getForecast(forecastId: string) {
    const forecast = await this.prisma.db.forecast.findFirst({
      where: { id: forecastId },
      include: { intervals: { orderBy: { startsAt: 'asc' } } },
    });
    if (!forecast) throw AppError.notFound('Forecast', forecastId);
    return forecast;
  }

  async deleteForecast(forecastId: string) {
    await this.getForecast(forecastId);
    await this.prisma.db.forecast.delete({ where: { id: forecastId } });
  }

  /**
   * Score a forecast against what actually happened.
   *
   * A forecast nobody grades is a forecast nobody can improve, so the actuals
   * are written back onto the intervals as well as summarized.
   */
  async scoreForecast(forecastId: string) {
    const forecast = await this.getForecast(forecastId);
    const organizationId = RequestContextStore.organizationId()!;

    const actual = await this.contactHistory({
      organizationId,
      since: forecast.startsAt,
      until: new Date(Math.min(forecast.endsAt.getTime(), Date.now())),
      intervalMinutes: forecast.intervalMinutes,
      queueId: forecast.queueId ?? undefined,
      channel: forecast.channel ?? undefined,
    });

    const actualByTime = new Map(actual.map((entry) => [entry.startsAt.getTime(), entry.volume]));
    for (const interval of forecast.intervals) {
      const observed = actualByTime.get(interval.startsAt.getTime());
      if (observed === undefined) continue;
      await this.prisma.db.forecastInterval.update({
        where: { id: interval.id },
        data: { actualVolume: observed },
      });
    }

    const accuracy = forecastAccuracy(
      forecast.intervals.map((interval) => ({
        startsAt: interval.startsAt,
        volume: interval.predictedVolume,
      })),
      actual,
    );

    await this.prisma.db.forecast.update({
      where: { id: forecastId },
      data: { accuracy: accuracy as unknown as Prisma.InputJsonValue },
    });
    return accuracy;
  }

  /**
   * Scheduled heads against required heads, interval by interval.
   *
   * The single most useful screen in workforce management: it is where a
   * planner sees the Tuesday afternoon nobody covered.
   */
  async coverage(forecastId: string) {
    const forecast = await this.getForecast(forecastId);
    const intervalMs = forecast.intervalMinutes * 60_000;

    const shifts = await this.prisma.db.shift.findMany({
      where: {
        state: 'published',
        startsAt: { lt: forecast.endsAt },
        endsAt: { gt: forecast.startsAt },
        ...(forecast.queueId ? { queueIds: { has: forecast.queueId } } : {}),
      },
      select: { userId: true, startsAt: true, endsAt: true, breaks: true },
    });

    const intervals = forecast.intervals.map((interval) => {
      const start = interval.startsAt.getTime();
      const end = start + intervalMs;

      // An agent counts as covering an interval only if they are on shift and
      // not on a break for the whole of it — a half-covered interval is not
      // half a person, it is a queue that backs up.
      const scheduled = shifts.filter((shift) => {
        if (shift.startsAt.getTime() > start || shift.endsAt.getTime() < end) return false;
        const breaks = (shift.breaks ?? []) as { startsAt: string; endsAt: string }[];
        return !breaks.some(
          (entry) =>
            new Date(entry.startsAt).getTime() < end && new Date(entry.endsAt).getTime() > start,
        );
      }).length;

      const achieved = evaluateStaffing(scheduled, {
        volume: interval.predictedVolume,
        averageHandleTimeSec: interval.averageHandleTimeSec,
        intervalSec: forecast.intervalMinutes * 60,
        targetServiceLevel: forecast.targetServiceLevel,
        targetAnswerSec: forecast.targetAnswerSec,
      });

      return {
        startsAt: interval.startsAt,
        predictedVolume: interval.predictedVolume,
        requiredAgents: interval.requiredAgents,
        scheduledAgents: scheduled,
        difference: scheduled - interval.requiredAgents,
        projectedServiceLevel: achieved.serviceLevel,
        projectedOccupancy: achieved.occupancy,
        confidence: interval.confidence,
      };
    });

    const understaffed = intervals.filter((interval) => interval.difference < 0);

    return {
      forecastId,
      intervals,
      summary: {
        intervals: intervals.length,
        understaffedIntervals: understaffed.length,
        // The number a planner acts on: the worst single gap, not the average,
        // because that is the interval customers will remember.
        worstDeficit: understaffed.length
          ? Math.min(...understaffed.map((interval) => interval.difference))
          : 0,
        totalAgentIntervalsShort: understaffed.reduce(
          (sum, interval) => sum + Math.abs(interval.difference),
          0,
        ),
      },
    };
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  async listTemplates() {
    return this.prisma.db.shiftTemplate.findMany({ orderBy: { name: 'asc' } });
  }

  async createTemplate(input: {
    name: string;
    startMinute: number;
    durationMinutes: number;
    daysOfWeek: number[];
    breaks?: { startMinute: number; durationMinutes: number; paid?: boolean }[];
    queueIds?: string[];
    timezone?: string;
  }) {
    if (input.daysOfWeek.some((day) => day < 0 || day > 6))
      throw AppError.badRequest('A day of the week is 0 (Sunday) to 6 (Saturday)');
    if (input.startMinute < 0 || input.startMinute >= 1440)
      throw AppError.badRequest('A shift starts within the day it belongs to');

    for (const entry of input.breaks ?? []) {
      if (entry.startMinute + entry.durationMinutes > input.durationMinutes)
        throw AppError.badRequest('A break has to finish before the shift does');
    }

    const clash = await this.prisma.db.shiftTemplate.findFirst({
      where: { name: input.name },
      select: { id: true },
    });
    if (clash) throw AppError.conflict(`A template named "${input.name}" already exists`);

    return this.prisma.db.shiftTemplate.create({
      data: {
        id: newId('shiftTemplate'),
        organizationId: RequestContextStore.organizationId()!,
        name: input.name,
        startMinute: input.startMinute,
        durationMinutes: input.durationMinutes,
        daysOfWeek: input.daysOfWeek,
        breaks: (input.breaks ?? []) as unknown as Prisma.InputJsonValue,
        queueIds: input.queueIds ?? [],
        timezone: input.timezone ?? 'UTC',
      },
    });
  }

  async deleteTemplate(templateId: string) {
    const template = await this.prisma.db.shiftTemplate.findFirst({ where: { id: templateId } });
    if (!template) throw AppError.notFound('Shift template', templateId);
    await this.prisma.db.shiftTemplate.delete({ where: { id: templateId } });
  }

  async listShifts(params: { from: Date; to: Date; userId?: string }) {
    return this.prisma.db.shift.findMany({
      where: {
        startsAt: { lt: params.to },
        endsAt: { gt: params.from },
        ...(params.userId ? { userId: params.userId } : {}),
      },
      orderBy: { startsAt: 'asc' },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
  }

  /**
   * Roster somebody. Refuses to double-book them, and refuses to schedule
   * over approved time off — both of which are only ever discovered on the
   * day if they are not caught here.
   */
  async createShift(input: ShiftInput) {
    if (input.startsAt >= input.endsAt) throw AppError.badRequest('A shift starts before it ends');

    const organizationId = RequestContextStore.organizationId()!;
    const membership = await this.prisma.db.membership.findFirst({
      where: { userId: input.userId },
      select: { id: true },
    });
    if (!membership) throw AppError.badRequest('That person is not a member of this organization');

    const overlap = await this.prisma.db.shift.findFirst({
      where: {
        userId: input.userId,
        state: { not: 'cancelled' },
        startsAt: { lt: input.endsAt },
        endsAt: { gt: input.startsAt },
      },
      select: { id: true, startsAt: true, endsAt: true },
    });
    if (overlap)
      throw AppError.conflict(
        `That person is already rostered from ${overlap.startsAt.toISOString()} to ${overlap.endsAt.toISOString()}`,
      );

    const timeOff = await this.prisma.db.timeOffRequest.findFirst({
      where: {
        userId: input.userId,
        status: 'approved',
        startsAt: { lt: input.endsAt },
        endsAt: { gt: input.startsAt },
      },
      select: { id: true, type: true },
    });
    if (timeOff)
      throw AppError.conflict(`That person has approved ${timeOff.type} covering this shift`);

    return this.prisma.db.shift.create({
      data: {
        id: newId('shift'),
        organizationId,
        userId: input.userId,
        templateId: input.templateId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        queueIds: input.queueIds ?? [],
        breaks: (input.breaks ?? []) as unknown as Prisma.InputJsonValue,
        note: input.note,
      },
    });
  }

  /**
   * Generate draft shifts from a template across a date range.
   *
   * Left as drafts on purpose: a generated roster is a proposal, and
   * publishing it is the moment people start planning their lives around it.
   */
  async applyTemplate(templateId: string, params: { from: Date; to: Date; userIds: string[] }) {
    const template = await this.prisma.db.shiftTemplate.findFirst({ where: { id: templateId } });
    if (!template) throw AppError.notFound('Shift template', templateId);

    const created: string[] = [];
    const skipped: { userId: string; date: string; reason: string }[] = [];

    for (
      let day = new Date(params.from);
      day < params.to;
      day = new Date(day.getTime() + 86_400_000)
    ) {
      if (!template.daysOfWeek.includes(day.getUTCDay())) continue;

      const startsAt = new Date(
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) +
          template.startMinute * 60_000,
      );
      const endsAt = new Date(startsAt.getTime() + template.durationMinutes * 60_000);
      const breaks = (
        (template.breaks ?? []) as { startMinute: number; durationMinutes: number }[]
      ).map((entry) => ({
        startsAt: new Date(startsAt.getTime() + entry.startMinute * 60_000),
        endsAt: new Date(startsAt.getTime() + (entry.startMinute + entry.durationMinutes) * 60_000),
      }));

      for (const userId of params.userIds) {
        try {
          const shift = await this.createShift({
            userId,
            startsAt,
            endsAt,
            templateId,
            queueIds: template.queueIds,
            breaks,
          });
          created.push(shift.id);
        } catch (error) {
          // One person's clash must not abandon the rest of the roster.
          skipped.push({
            userId,
            date: startsAt.toISOString().slice(0, 10),
            reason: error instanceof AppError ? error.message : 'could not be rostered',
          });
        }
      }
    }

    return { created: created.length, skipped };
  }

  /** Publishing is what makes a roster real, so it is audited. */
  async publishShifts(params: { from: Date; to: Date }) {
    const result = await this.prisma.db.shift.updateMany({
      where: { state: 'draft', startsAt: { gte: params.from }, endsAt: { lte: params.to } },
      data: { state: 'published', publishedAt: new Date() },
    });

    await this.audit.record({
      action: 'wfm.schedule_published',
      resourceType: 'shift',
      after: { from: params.from, to: params.to, shifts: result.count },
    });
    return { published: result.count };
  }

  async cancelShift(shiftId: string) {
    const shift = await this.prisma.db.shift.findFirst({ where: { id: shiftId } });
    if (!shift) throw AppError.notFound('Shift', shiftId);
    return this.prisma.db.shift.update({ where: { id: shiftId }, data: { state: 'cancelled' } });
  }

  // ── Time off ───────────────────────────────────────────────────────────────

  async requestTimeOff(input: {
    userId: string;
    startsAt: Date;
    endsAt: Date;
    type?: string;
    reason?: string;
  }) {
    if (input.startsAt >= input.endsAt) throw AppError.badRequest('Time off starts before it ends');

    return this.prisma.db.timeOffRequest.create({
      data: {
        id: newId('timeOff'),
        organizationId: RequestContextStore.organizationId()!,
        userId: input.userId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        type: input.type ?? 'holiday',
        reason: input.reason,
      },
    });
  }

  async listTimeOff(params: { from?: Date; to?: Date; userId?: string; status?: string } = {}) {
    return this.prisma.db.timeOffRequest.findMany({
      where: {
        ...(params.userId ? { userId: params.userId } : {}),
        ...(params.status ? { status: params.status as never } : {}),
        ...(params.from ? { endsAt: { gt: params.from } } : {}),
        ...(params.to ? { startsAt: { lt: params.to } } : {}),
      },
      orderBy: { startsAt: 'asc' },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
  }

  /**
   * Approving time off cancels any shift it now collides with, rather than
   * leaving a roster that says someone is working while the holiday screen
   * says they are away.
   */
  async decideTimeOff(requestId: string, approve: boolean, note?: string) {
    const request = await this.prisma.db.timeOffRequest.findFirst({ where: { id: requestId } });
    if (!request) throw AppError.notFound('Time off request', requestId);
    if (request.status !== 'requested')
      throw AppError.conflict(`This request was already ${request.status}`);

    const updated = await this.prisma.db.timeOffRequest.update({
      where: { id: requestId },
      data: {
        status: approve ? 'approved' : 'declined',
        decidedById: RequestContextStore.principal()?.id,
        decidedAt: new Date(),
        decisionNote: note,
      },
    });

    if (approve) {
      const cancelled = await this.prisma.db.shift.updateMany({
        where: {
          userId: request.userId,
          state: { not: 'cancelled' },
          startsAt: { lt: request.endsAt },
          endsAt: { gt: request.startsAt },
        },
        data: { state: 'cancelled' },
      });
      if (cancelled.count)
        this.logger.info('Time off cancelled rostered shifts', {
          requestId,
          shifts: cancelled.count,
        });
    }

    return updated;
  }

  // ── Adherence ──────────────────────────────────────────────────────────────

  /** Record a presence transition. Adherence is computed from these. */
  async recordStateChange(userId: string, state: AgentPresence, source = 'user', note?: string) {
    const organizationId = RequestContextStore.organizationId();
    if (!organizationId) return;

    await this.prisma.raw.agentStateEvent.create({
      data: { id: newId('stateEvent'), organizationId, userId, state, source, note },
    });
  }

  /**
   * Adherence for one person on one day.
   *
   * Adherence asks "were they available *when* they were scheduled"; conformance
   * asks only "did they work the hours". Both are reported because they fail
   * differently: someone who works a full shift two hours late is 100%
   * conformant and badly non-adherent, and only one of those numbers finds it.
   */
  async computeAdherence(userId: string, date: Date) {
    const organizationId = RequestContextStore.organizationId()!;
    const dayStart = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    const [shifts, events] = await Promise.all([
      this.prisma.db.shift.findMany({
        where: {
          userId,
          state: 'published',
          startsAt: { lt: dayEnd },
          endsAt: { gt: dayStart },
        },
        select: { startsAt: true, endsAt: true, breaks: true },
      }),
      this.prisma.raw.agentStateEvent.findMany({
        where: { userId, occurredAt: { lt: dayEnd } },
        orderBy: { occurredAt: 'asc' },
        select: { state: true, occurredAt: true },
      }),
    ]);

    const scheduled = this.minuteMask(dayStart, shifts);
    const available = this.availabilityMask(dayStart, dayEnd, events);

    let scheduledMinutes = 0;
    let adherentMinutes = 0;
    let unscheduledMinutes = 0;

    for (let minute = 0; minute < 1440; minute += 1) {
      if (scheduled[minute]) {
        scheduledMinutes += 1;
        if (available[minute]) adherentMinutes += 1;
      } else if (available[minute]) {
        unscheduledMinutes += 1;
      }
    }

    const workedMinutes = adherentMinutes + unscheduledMinutes;
    const adherencePercent = scheduledMinutes
      ? Math.round((adherentMinutes / scheduledMinutes) * 10_000) / 100
      : 0;
    const conformancePercent = scheduledMinutes
      ? Math.round((workedMinutes / scheduledMinutes) * 10_000) / 100
      : 0;

    return this.prisma.raw.adherenceRecord.upsert({
      where: { userId_date: { userId, date: dayStart } },
      create: {
        id: newId('adherence'),
        organizationId,
        userId,
        date: dayStart,
        scheduledMinutes,
        adherentMinutes,
        unscheduledMinutes,
        adherencePercent,
        conformancePercent,
      },
      update: {
        scheduledMinutes,
        adherentMinutes,
        unscheduledMinutes,
        adherencePercent,
        conformancePercent,
        computedAt: new Date(),
      },
    });
  }

  async adherenceReport(params: { from: Date; to: Date; userId?: string }) {
    const records = await this.prisma.raw.adherenceRecord.findMany({
      where: {
        organizationId: RequestContextStore.organizationId()!,
        date: { gte: params.from, lte: params.to },
        ...(params.userId ? { userId: params.userId } : {}),
      },
      orderBy: [{ date: 'asc' }],
    });

    const scheduled = records.reduce((sum, record) => sum + record.scheduledMinutes, 0);
    const adherent = records.reduce((sum, record) => sum + record.adherentMinutes, 0);

    return {
      records,
      summary: {
        days: records.length,
        scheduledMinutes: scheduled,
        adherentMinutes: adherent,
        adherencePercent: scheduled ? Math.round((adherent / scheduled) * 10_000) / 100 : 0,
      },
    };
  }

  /** Compute adherence for everyone who was rostered yesterday. */
  async computeAdherenceForDay(date: Date): Promise<number> {
    const dayStart = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    const shifts = await this.prisma.db.shift.findMany({
      where: { state: 'published', startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
      select: { userId: true },
      distinct: ['userId'],
    });

    for (const shift of shifts) {
      await this.computeAdherence(shift.userId, dayStart).catch((error) =>
        this.logger.error('Computing adherence failed', error, { userId: shift.userId }),
      );
    }
    return shifts.length;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Minutes of the day covered by a shift and not by one of its breaks. */
  private minuteMask(
    dayStart: Date,
    shifts: { startsAt: Date; endsAt: Date; breaks: Prisma.JsonValue }[],
  ): boolean[] {
    const mask = new Array<boolean>(1440).fill(false);

    for (const shift of shifts) {
      const from = Math.max(
        0,
        Math.floor((shift.startsAt.getTime() - dayStart.getTime()) / 60_000),
      );
      const to = Math.min(1440, Math.ceil((shift.endsAt.getTime() - dayStart.getTime()) / 60_000));
      for (let minute = from; minute < to; minute += 1) mask[minute] = true;

      for (const entry of (shift.breaks ?? []) as { startsAt: string; endsAt: string }[]) {
        const breakFrom = Math.max(
          0,
          Math.floor((new Date(entry.startsAt).getTime() - dayStart.getTime()) / 60_000),
        );
        const breakTo = Math.min(
          1440,
          Math.ceil((new Date(entry.endsAt).getTime() - dayStart.getTime()) / 60_000),
        );
        for (let minute = breakFrom; minute < breakTo; minute += 1) mask[minute] = false;
      }
    }

    return mask;
  }

  /**
   * Minutes the agent was actually available.
   *
   * Built by walking the transitions in order and carrying the last state
   * forward — the state at midnight is set by the most recent event *before*
   * the day, which is why the query does not filter on the day's start.
   */
  private availabilityMask(
    dayStart: Date,
    dayEnd: Date,
    events: { state: AgentPresence; occurredAt: Date }[],
  ): boolean[] {
    const mask = new Array<boolean>(1440).fill(false);
    if (!events.length) return mask;

    let current: AgentPresence = 'offline';
    let cursor = 0;

    for (const event of events) {
      if (event.occurredAt < dayStart) {
        current = event.state;
        continue;
      }
      if (event.occurredAt >= dayEnd) break;

      const minute = Math.floor((event.occurredAt.getTime() - dayStart.getTime()) / 60_000);
      if (AVAILABLE_STATES.includes(current)) {
        for (let i = cursor; i < minute && i < 1440; i += 1) mask[i] = true;
      }
      cursor = minute;
      current = event.state;
    }

    if (AVAILABLE_STATES.includes(current)) {
      for (let i = cursor; i < 1440; i += 1) mask[i] = true;
    }

    return mask;
  }

  /**
   * Contact volume per interval, from conversations.
   *
   * Raw SQL because bucketing by an arbitrary interval is a `date_bin`, which
   * Prisma cannot express — and because the tenant guard does not see raw SQL,
   * the organization predicate is added here and is never conditional.
   */
  private async contactHistory(params: {
    organizationId: string;
    since: Date;
    until: Date;
    intervalMinutes: number;
    queueId?: string;
    channel?: ChannelType;
  }): Promise<HistoricalInterval[]> {
    const filters: string[] = ['c.organization_id = $1', 'c.created_at >= $2', 'c.created_at < $3'];
    const values: unknown[] = [params.organizationId, params.since, params.until];

    if (params.queueId) {
      values.push(params.queueId);
      filters.push(`c.queue_id = $${values.length}`);
    }
    if (params.channel) {
      values.push(params.channel);
      filters.push(`c.channel = $${values.length}::"ChannelType"`);
    }
    values.push(`${params.intervalMinutes} minutes`);
    const intervalParam = `$${values.length}`;

    const rows = await this.prisma.raw.$queryRawUnsafe<
      { bucket: Date; volume: bigint; aht: number | null }[]
    >(
      `SELECT date_bin(${intervalParam}::interval, c.created_at, TIMESTAMP '2000-01-01') AS bucket,
              COUNT(*) AS volume,
              AVG(EXTRACT(EPOCH FROM (c.resolved_at - c.created_at)))
                FILTER (WHERE c.resolved_at IS NOT NULL) AS aht
         FROM conversations c
        WHERE ${filters.join(' AND ')}
        GROUP BY 1
        ORDER BY 1`,
      ...values,
    );

    return rows.map((row) => ({
      startsAt: row.bucket,
      volume: Number(row.volume),
      averageHandleTimeSec: row.aht ? Math.round(row.aht) : undefined,
    }));
  }
}
