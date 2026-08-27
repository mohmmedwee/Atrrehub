import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { ApiOptionalQuery, ApiZodBody, ApiZodQuery } from '../../core/http/zod-openapi';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { calculateStaffing, evaluateStaffing } from './staffing';
import { WfmService } from './wfm.service';

const ForecastSchema = z
  .object({
    name: z.string().min(2).max(120),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    queueId: z.string().optional(),
    channel: z
      .enum([
        'web_chat',
        'email',
        'voice',
        'whatsapp',
        'sms',
        'telegram',
        'messenger',
        'instagram',
        'teams',
        'api',
      ])
      .optional(),
    intervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(),
    lookbackWeeks: z.number().int().min(1).max(26).optional(),
    growthFactor: z.number().min(0).max(10).optional(),
    shrinkage: z.number().min(0).max(0.9).optional(),
    targetServiceLevel: z.number().min(0.1).max(1).optional(),
    targetAnswerSec: z.number().int().min(1).max(600).optional(),
    maxOccupancy: z.number().min(0.1).max(1).optional(),
  })
  .strict();

const StaffingSchema = z
  .object({
    volume: z.number().min(0).max(1_000_000),
    averageHandleTimeSec: z.number().min(1).max(36_000),
    intervalSec: z.number().int().min(60).max(86_400),
    targetServiceLevel: z.number().min(0.1).max(1),
    targetAnswerSec: z.number().int().min(1).max(3600),
    shrinkage: z.number().min(0).max(0.9).optional(),
    maxOccupancy: z.number().min(0.1).max(1).optional(),
    /** Given instead of asked for: what would this many agents deliver? */
    agents: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

const TemplateSchema = z
  .object({
    name: z.string().min(2).max(80),
    startMinute: z.number().int().min(0).max(1439),
    durationMinutes: z.number().int().min(30).max(1440),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    breaks: z
      .array(
        z.object({
          startMinute: z.number().int().min(0),
          durationMinutes: z.number().int().min(5).max(240),
          paid: z.boolean().optional(),
        }),
      )
      .max(6)
      .optional(),
    queueIds: z.array(z.string()).max(20).optional(),
    timezone: z.string().max(60).optional(),
  })
  .strict();

const ShiftSchema = z
  .object({
    userId: z.string(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    templateId: z.string().optional(),
    queueIds: z.array(z.string()).max(20).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

const ApplySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    userIds: z.array(z.string()).min(1).max(200),
  })
  .strict();

const RangeQuery = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  userId: z.string().optional(),
});

const TimeOffSchema = z
  .object({
    userId: z.string(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    type: z.enum(['holiday', 'sick', 'training', 'other']).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

@ApiTags('Workforce management')
@Controller('wfm')
export class WfmController {
  constructor(private readonly wfm: WfmService) {}

  // ── Staffing calculator ────────────────────────────────────────────────────

  @Post('staffing')
  @RequirePermissions('wfm:read')
  @ApiOperation({
    summary: 'Erlang C: agents needed for an interval, or what given agents deliver',
  })
  @ApiZodBody(StaffingSchema)
  staffing(@Body(zodBody(StaffingSchema)) body: z.infer<typeof StaffingSchema>) {
    const { agents, ...input } = body;
    return agents === undefined
      ? calculateStaffing(input)
      : { agents, ...evaluateStaffing(agents, input) };
  }

  // ── Forecasts ──────────────────────────────────────────────────────────────

  @Get('forecasts')
  @RequirePermissions('wfm:read')
  @ApiOperation({ summary: 'List forecasts' })
  listForecasts() {
    return this.wfm.listForecasts();
  }

  @Post('forecasts')
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Forecast volume from history and size every interval' })
  @ApiZodBody(ForecastSchema)
  createForecast(@Body(zodBody(ForecastSchema)) body: z.infer<typeof ForecastSchema>) {
    return this.wfm.generateForecast(body);
  }

  @Get('forecasts/:forecastId')
  @RequirePermissions('wfm:read')
  @ApiOperation({ summary: 'Get a forecast with every interval' })
  getForecast(@Param('forecastId') forecastId: string) {
    return this.wfm.getForecast(forecastId);
  }

  @Get('forecasts/:forecastId/coverage')
  @RequirePermissions('wfm:read')
  @ApiOperation({ summary: 'Rostered heads against required heads, interval by interval' })
  coverage(@Param('forecastId') forecastId: string) {
    return this.wfm.coverage(forecastId);
  }

  @Post('forecasts/:forecastId/score')
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Grade the forecast against what actually arrived' })
  score(@Param('forecastId') forecastId: string) {
    return this.wfm.scoreForecast(forecastId);
  }

  @Delete('forecasts/:forecastId')
  @HttpCode(204)
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Delete a forecast' })
  async deleteForecast(@Param('forecastId') forecastId: string) {
    await this.wfm.deleteForecast(forecastId);
  }

  // ── Schedule ───────────────────────────────────────────────────────────────

  @Get('templates')
  @RequirePermissions('wfm:read')
  @ApiOperation({ summary: 'List shift templates' })
  listTemplates() {
    return this.wfm.listTemplates();
  }

  @Post('templates')
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Create a shift template' })
  @ApiZodBody(TemplateSchema)
  createTemplate(@Body(zodBody(TemplateSchema)) body: z.infer<typeof TemplateSchema>) {
    return this.wfm.createTemplate(body);
  }

  @Delete('templates/:templateId')
  @HttpCode(204)
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Delete a shift template' })
  async deleteTemplate(@Param('templateId') templateId: string) {
    await this.wfm.deleteTemplate(templateId);
  }

  @Post('templates/:templateId/apply')
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Generate draft shifts from a template across a date range' })
  @ApiZodBody(ApplySchema)
  applyTemplate(
    @Param('templateId') templateId: string,
    @Body(zodBody(ApplySchema)) body: z.infer<typeof ApplySchema>,
  ) {
    return this.wfm.applyTemplate(templateId, body);
  }

  @Get('shifts')
  @RequirePermissions('wfm:read')
  @ApiOperation({ summary: 'List shifts in a window' })
  @ApiZodQuery(RangeQuery)
  listShifts(@Query(zodQuery(RangeQuery)) query: z.infer<typeof RangeQuery>) {
    return this.wfm.listShifts(query);
  }

  @Post('shifts')
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Roster a shift; double-booking and approved time off are refused' })
  @ApiZodBody(ShiftSchema)
  createShift(@Body(zodBody(ShiftSchema)) body: z.infer<typeof ShiftSchema>) {
    return this.wfm.createShift(body);
  }

  @Post('shifts/publish')
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Publish the draft roster for a window' })
  publish(
    @Body(zodBody(z.object({ from: z.coerce.date(), to: z.coerce.date() }).strict()))
    body: {
      from: Date;
      to: Date;
    },
  ) {
    return this.wfm.publishShifts(body);
  }

  @Delete('shifts/:shiftId')
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Cancel a shift' })
  cancelShift(@Param('shiftId') shiftId: string) {
    return this.wfm.cancelShift(shiftId);
  }

  // ── Time off ───────────────────────────────────────────────────────────────

  @Get('time-off')
  @RequirePermissions('wfm:read')
  @ApiOperation({ summary: 'List time off requests' })
  @ApiOptionalQuery('from', 'to', 'userId', 'status')
  listTimeOff(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId') userId?: string,
    @Query('status') status?: string,
  ) {
    return this.wfm.listTimeOff({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      userId,
      status,
    });
  }

  @Post('time-off')
  @RequirePermissions('wfm:read')
  @ApiOperation({ summary: 'Request time off' })
  @ApiZodBody(TimeOffSchema)
  requestTimeOff(@Body(zodBody(TimeOffSchema)) body: z.infer<typeof TimeOffSchema>) {
    return this.wfm.requestTimeOff(body);
  }

  @Post('time-off/:requestId/approve')
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Approve time off; colliding shifts are cancelled' })
  approve(
    @Param('requestId') requestId: string,
    @Body(zodBody(z.object({ note: z.string().max(500).optional() }).strict()))
    body: { note?: string },
  ) {
    return this.wfm.decideTimeOff(requestId, true, body.note);
  }

  @Post('time-off/:requestId/decline')
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Decline time off' })
  decline(
    @Param('requestId') requestId: string,
    @Body(zodBody(z.object({ note: z.string().max(500).optional() }).strict()))
    body: { note?: string },
  ) {
    return this.wfm.decideTimeOff(requestId, false, body.note);
  }

  // ── Adherence ──────────────────────────────────────────────────────────────

  @Get('adherence')
  @RequirePermissions('wfm:read')
  @ApiOperation({ summary: 'Adherence and conformance over a date range' })
  @ApiZodQuery(RangeQuery)
  adherence(@Query(zodQuery(RangeQuery)) query: z.infer<typeof RangeQuery>) {
    return this.wfm.adherenceReport(query);
  }

  @Post('adherence/compute')
  @RequirePermissions('wfm:manage')
  @ApiOperation({ summary: 'Recompute adherence for a day' })
  computeAdherence(
    @Body(zodBody(z.object({ date: z.coerce.date() }).strict())) body: { date: Date },
  ) {
    return this.wfm
      .computeAdherenceForDay(body.date)
      .then((agents) => ({ date: body.date, agents }));
  }
}
