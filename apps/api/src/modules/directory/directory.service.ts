import { Injectable } from '@nestjs/common';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { BusinessHoursCalculator, type BusinessHoursRule } from './business-hours';

const CALENDAR_CACHE_TTL = 300;

/**
 * Organization administration: teams, queues, business hours, holidays and the
 * taxonomy (custom fields, tags, saved replies) shared across every module.
 */
@Injectable()
export class DirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  private get orgId(): string {
    const id = RequestContextStore.organizationId();
    if (!id) throw AppError.internal('No organization in scope');
    return id;
  }

  // ── Teams ──────────────────────────────────────────────────────────────────

  async listTeams() {
    return this.prisma.db.team.findMany({
      where: {},
      include: {
        members: { include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true, presence: true } } } },
        _count: { select: { queues: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createTeam(input: {
    name: string;
    description?: string;
    businessHoursId?: string | null;
    skills?: string[];
    languages?: string[];
    memberIds?: string[];
    workspaceId?: string;
  }) {
    const team = await this.prisma.db.team.create({
      data: {
        id: newId('team'),
        name: input.name,
        description: input.description ?? null,
        businessHoursId: input.businessHoursId ?? null,
        skills: input.skills ?? [],
        languages: input.languages ?? [],
        workspaceId: input.workspaceId ?? null,
      } as never,
    });
    if (input.memberIds?.length) await this.setTeamMembers(team.id, input.memberIds);
    await this.audit.record({ action: 'team.created', resourceType: 'team', resourceId: team.id, after: team });
    return this.getTeam(team.id);
  }

  async getTeam(teamId: string) {
    const team = await this.prisma.db.team.findFirst({
      where: { id: teamId },
      include: {
        members: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true, presence: true } } } },
        queues: { select: { id: true, name: true, key: true } },
      },
    });
    if (!team) throw AppError.notFound('Team', teamId);
    return team;
  }

  async updateTeam(teamId: string, patch: Record<string, unknown> & { memberIds?: string[] }) {
    const before = await this.getTeam(teamId);
    const { memberIds, ...data } = patch;
    if (Object.keys(data).length) {
      await this.prisma.db.team.update({ where: { id: teamId }, data: data as never });
    }
    if (memberIds) await this.setTeamMembers(teamId, memberIds);
    const after = await this.getTeam(teamId);
    await this.audit.recordDiff('team.updated', 'team', teamId, before as never, after as never);
    return after;
  }

  async deleteTeam(teamId: string) {
    const team = await this.getTeam(teamId);
    await this.prisma.db.team.delete({ where: { id: teamId } });
    await this.audit.record({ action: 'team.deleted', resourceType: 'team', resourceId: teamId, before: team });
  }

  /** Replaces the roster in one transaction so membership never half-applies. */
  private async setTeamMembers(teamId: string, userIds: string[]) {
    const members = await this.prisma.db.membership.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true },
    });
    const valid = new Set(members.map((m) => m.userId));
    const invalid = userIds.filter((id) => !valid.has(id));
    if (invalid.length) throw AppError.badRequest(`Not members of this organization: ${invalid.join(', ')}`);

    await this.prisma.raw.$transaction([
      this.prisma.raw.teamMember.deleteMany({ where: { teamId } }),
      this.prisma.raw.teamMember.createMany({
        data: userIds.map((userId) => ({ id: newId('teamMember'), teamId, userId })),
      }),
    ]);
  }

  // ── Queues ─────────────────────────────────────────────────────────────────

  async listQueues() {
    return this.prisma.db.queue.findMany({
      where: {},
      include: {
        team: { select: { id: true, name: true } },
        slaPolicy: { select: { id: true, name: true } },
        _count: { select: { conversations: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createQueue(input: Record<string, unknown> & { name: string; key: string }) {
    const existing = await this.prisma.db.queue.findFirst({ where: { key: input.key } });
    if (existing) throw AppError.conflict(`A queue with the key "${input.key}" already exists`);
    const queue = await this.prisma.db.queue.create({ data: { id: newId('queue'), ...input } as never });
    await this.audit.record({ action: 'queue.created', resourceType: 'queue', resourceId: queue.id, after: queue });
    return queue;
  }

  async getQueue(queueId: string) {
    const queue = await this.prisma.db.queue.findFirst({
      where: { id: queueId },
      include: { team: true, slaPolicy: true, businessHours: true },
    });
    if (!queue) throw AppError.notFound('Queue', queueId);
    return queue;
  }

  async updateQueue(queueId: string, patch: Record<string, unknown>) {
    const before = await this.getQueue(queueId);
    const after = await this.prisma.db.queue.update({ where: { id: queueId }, data: patch as never });
    await this.audit.recordDiff('queue.updated', 'queue', queueId, before as never, after as never);
    return after;
  }

  async deleteQueue(queueId: string) {
    const open = await this.prisma.db.conversation.count({
      where: { queueId, status: { in: ['new', 'queued', 'assigned', 'active', 'waiting'] } },
    });
    if (open > 0) throw AppError.conflict(`${open} open conversation(s) are still in this queue`);
    await this.prisma.db.queue.delete({ where: { id: queueId } });
    await this.audit.record({ action: 'queue.deleted', resourceType: 'queue', resourceId: queueId });
  }

  // ── Business hours & holidays ──────────────────────────────────────────────

  async listBusinessHours() {
    return this.prisma.db.businessHours.findMany({
      where: {},
      include: { holidays: { orderBy: { date: 'asc' } } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async createBusinessHours(input: { name: string; timezone: string; rules: BusinessHoursRule[]; isDefault?: boolean }) {
    this.assertValidRules(input.rules);
    if (input.isDefault) await this.prisma.db.businessHours.updateMany({ where: {}, data: { isDefault: false } });
    const created = await this.prisma.db.businessHours.create({
      data: {
        id: newId('businessHours'),
        name: input.name,
        timezone: input.timezone,
        rules: input.rules as never,
        isDefault: input.isDefault ?? false,
      } as never,
    });
    await this.audit.record({ action: 'business_hours.created', resourceType: 'business_hours', resourceId: created.id, after: created });
    return created;
  }

  async updateBusinessHours(id: string, patch: { name?: string; timezone?: string; rules?: BusinessHoursRule[]; isDefault?: boolean }) {
    if (patch.rules) this.assertValidRules(patch.rules);
    if (patch.isDefault) await this.prisma.db.businessHours.updateMany({ where: {}, data: { isDefault: false } });
    const updated = await this.prisma.db.businessHours.update({ where: { id }, data: patch as never });
    await this.invalidateCalendar(id);
    await this.audit.record({ action: 'business_hours.updated', resourceType: 'business_hours', resourceId: id, after: updated });
    return updated;
  }

  async deleteBusinessHours(id: string) {
    const record = await this.prisma.db.businessHours.findFirst({ where: { id } });
    if (!record) throw AppError.notFound('Business hours', id);
    if (record.isDefault) throw AppError.conflict('The default business hours cannot be deleted');
    await this.prisma.db.businessHours.delete({ where: { id } });
    await this.invalidateCalendar(id);
  }

  async addHoliday(businessHoursId: string, input: { name: string; date: string; recurring?: boolean }) {
    const holiday = await this.prisma.db.holiday.create({
      data: {
        id: newId('holiday'),
        businessHoursId,
        name: input.name,
        date: new Date(`${input.date}T00:00:00Z`),
        recurring: input.recurring ?? false,
      } as never,
    });
    await this.invalidateCalendar(businessHoursId);
    return holiday;
  }

  async deleteHoliday(holidayId: string) {
    const holiday = await this.prisma.db.holiday.findFirst({ where: { id: holidayId } });
    if (!holiday) throw AppError.notFound('Holiday', holidayId);
    await this.prisma.db.holiday.delete({ where: { id: holidayId } });
    if (holiday.businessHoursId) await this.invalidateCalendar(holiday.businessHoursId);
  }

  private assertValidRules(rules: BusinessHoursRule[]): void {
    for (const rule of rules) {
      if (rule.day < 0 || rule.day > 6) throw AppError.badRequest('day must be between 0 (Sunday) and 6 (Saturday)');
      if (!/^\d{2}:\d{2}$/.test(rule.start) || !/^\d{2}:\d{2}$/.test(rule.end)) {
        throw AppError.badRequest('start and end must be formatted HH:mm');
      }
      if (rule.end <= rule.start) throw AppError.badRequest('end must be later than start');
    }
  }

  /**
   * Builds the calculator for a calendar, cached because SLA evaluation reads it
   * on every clock tick. Recurring holidays are expanded across a rolling
   * three-year window so annual closures need to be entered only once.
   */
  async calendarFor(businessHoursId: string | null | undefined): Promise<BusinessHoursCalculator> {
    const organizationId = this.orgId;
    const key = this.redis.key(organizationId, 'calendar', businessHoursId ?? 'default');

    const calendar = await this.redis.remember(key, CALENDAR_CACHE_TTL, async () => {
      const record = businessHoursId
        ? await this.prisma.db.businessHours.findFirst({ where: { id: businessHoursId }, include: { holidays: true } })
        : await this.prisma.db.businessHours.findFirst({ where: { isDefault: true }, include: { holidays: true } });

      // No calendar configured means 24×7: never let a missing config invent an SLA breach.
      if (!record) return { timezone: 'UTC', rules: [], holidays: [] };

      const currentYear = new Date().getUTCFullYear();
      const holidays = record.holidays.flatMap((holiday) => {
        const iso = holiday.date.toISOString().slice(0, 10);
        if (!holiday.recurring) return [iso];
        const monthDay = iso.slice(5);
        return [currentYear - 1, currentYear, currentYear + 1].map((year) => `${year}-${monthDay}`);
      });

      return {
        timezone: record.timezone,
        rules: (record.rules as unknown as BusinessHoursRule[]) ?? [],
        holidays,
      };
    });

    return new BusinessHoursCalculator(calendar);
  }

  private async invalidateCalendar(businessHoursId: string): Promise<void> {
    await this.redis.del(
      this.redis.key(this.orgId, 'calendar', businessHoursId),
      this.redis.key(this.orgId, 'calendar', 'default'),
    );
  }

  // ── Taxonomy ───────────────────────────────────────────────────────────────

  async listTags() {
    return this.prisma.db.tag.findMany({ where: {}, orderBy: { name: 'asc' } });
  }

  async createTag(input: { name: string; color?: string; category?: string }) {
    return this.prisma.db.tag.create({
      data: { id: newId('tag'), name: input.name, color: input.color ?? '#64748b', category: input.category ?? null } as never,
    });
  }

  async deleteTag(tagId: string) {
    await this.prisma.db.tag.delete({ where: { id: tagId } });
  }

  async listCustomFields(entity?: string) {
    return this.prisma.db.customField.findMany({
      where: entity ? { entity } : {},
      orderBy: [{ entity: 'asc' }, { position: 'asc' }],
    });
  }

  async createCustomField(input: {
    entity: string;
    key: string;
    label: string;
    type: string;
    options?: unknown[];
    isRequired?: boolean;
    position?: number;
  }) {
    const existing = await this.prisma.db.customField.findFirst({ where: { entity: input.entity, key: input.key } });
    if (existing) throw AppError.conflict(`A "${input.key}" field already exists on ${input.entity}`);
    return this.prisma.db.customField.create({
      data: {
        id: newId('customField'),
        entity: input.entity,
        key: input.key,
        label: input.label,
        type: input.type,
        options: (input.options ?? []) as never,
        isRequired: input.isRequired ?? false,
        position: input.position ?? 0,
      } as never,
    });
  }

  async deleteCustomField(fieldId: string) {
    await this.prisma.db.customField.delete({ where: { id: fieldId } });
  }

  /**
   * Validates a custom-field payload against the tenant's field definitions.
   * Unknown keys are rejected so a typo cannot silently create shadow data.
   */
  async validateCustomFields(entity: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fields = await this.listCustomFields(entity);
    const byKey = new Map(fields.map((f) => [f.key, f]));

    const unknown = Object.keys(values).filter((key) => !byKey.has(key));
    if (unknown.length) throw AppError.badRequest(`Unknown custom fields on ${entity}: ${unknown.join(', ')}`);

    for (const field of fields) {
      const value = values[field.key];
      if (value === undefined || value === null) {
        if (field.isRequired) throw AppError.badRequest(`Custom field "${field.label}" is required`);
        continue;
      }
      const typeOk =
        (field.type === 'text' && typeof value === 'string') ||
        (field.type === 'number' && typeof value === 'number') ||
        (field.type === 'boolean' && typeof value === 'boolean') ||
        (field.type === 'date' && !Number.isNaN(Date.parse(String(value)))) ||
        (field.type === 'select' && (field.options as string[]).includes(String(value))) ||
        (field.type === 'multiselect' &&
          Array.isArray(value) &&
          value.every((v) => (field.options as string[]).includes(String(v))));
      if (!typeOk) throw AppError.badRequest(`Custom field "${field.label}" expects a ${field.type} value`);
    }
    return values;
  }

  async listSavedReplies(locale?: string) {
    return this.prisma.db.savedReply.findMany({
      where: locale ? { locale } : {},
      orderBy: { title: 'asc' },
    });
  }

  async createSavedReply(input: { title: string; body: string; shortcut?: string; locale?: string; tags?: string[] }) {
    const principal = RequestContextStore.principal();
    return this.prisma.db.savedReply.create({
      data: {
        id: newId('savedReply'),
        title: input.title,
        body: input.body,
        shortcut: input.shortcut ?? null,
        locale: input.locale ?? 'en',
        tags: input.tags ?? [],
        createdById: principal?.id ?? null,
      } as never,
    });
  }

  async updateSavedReply(id: string, patch: Record<string, unknown>) {
    return this.prisma.db.savedReply.update({ where: { id }, data: patch as never });
  }

  async deleteSavedReply(id: string) {
    await this.prisma.db.savedReply.delete({ where: { id } });
  }
}
