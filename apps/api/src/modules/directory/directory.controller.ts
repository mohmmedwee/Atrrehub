import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { ApiOptionalQuery, ApiZodBody } from '../../core/http/zod-openapi';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { DirectoryService } from './directory.service';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

const TeamSchema = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(300).optional(),
    businessHoursId: z.string().nullable().optional(),
    skills: z.array(z.string().max(40)).max(50).optional(),
    languages: z.array(z.string().max(10)).max(20).optional(),
    memberIds: z.array(z.string()).max(500).optional(),
    workspaceId: z.string().optional(),
  })
  .strict();

const QueueSchema = z
  .object({
    name: z.string().min(2).max(80),
    key: z
      .string()
      .min(2)
      .max(40)
      .regex(/^[a-z][a-z0-9_-]*$/, 'Use lower case letters, digits, hyphen or underscore'),
    description: z.string().max(300).optional(),
    teamId: z.string().nullable().optional(),
    channels: z
      .array(
        z.enum([
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
        ]),
      )
      .optional(),
    languages: z.array(z.string().max(10)).max(20).optional(),
    skills: z.array(z.string().max(40)).max(50).optional(),
    strategy: z
      .enum([
        'round_robin',
        'least_loaded',
        'skill_based',
        'language',
        'priority',
        'customer_tier',
        'team',
        'ai_intent',
        'sentiment',
        'direct',
      ])
      .optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent', 'critical']).optional(),
    slaPolicyId: z.string().nullable().optional(),
    businessHoursId: z.string().nullable().optional(),
    aiAgentId: z.string().nullable().optional(),
    aiFirst: z.boolean().optional(),
    maxWaitSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
    isActive: z.boolean().optional(),
    workspaceId: z.string().optional(),
  })
  .strict();

const BusinessHoursSchema = z
  .object({
    name: z.string().min(2).max(80),
    timezone: z.string().min(1).max(60),
    rules: z
      .array(z.object({ day: z.number().int().min(0).max(6), start: HHMM, end: HHMM }).strict())
      .max(21),
    isDefault: z.boolean().optional(),
  })
  .strict();

const HolidaySchema = z
  .object({
    name: z.string().min(1).max(80),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
    recurring: z.boolean().optional(),
  })
  .strict();

const TagSchema = z
  .object({
    name: z.string().min(1).max(60),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    category: z.string().max(40).optional(),
  })
  .strict();

const CustomFieldSchema = z
  .object({
    entity: z.enum(['customer', 'ticket', 'conversation']),
    key: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-zA-Z0-9_]*$/, 'Use a camelCase or snake_case identifier'),
    label: z.string().min(1).max(80),
    type: z.enum(['text', 'number', 'boolean', 'date', 'select', 'multiselect']),
    options: z.array(z.string().max(80)).max(200).optional(),
    isRequired: z.boolean().optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .strict()
  .refine(
    (value) => !['select', 'multiselect'].includes(value.type) || (value.options?.length ?? 0) > 0,
    {
      message: 'select and multiselect fields need at least one option',
      path: ['options'],
    },
  );

const SavedReplySchema = z
  .object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(8000),
    shortcut: z.string().max(40).optional(),
    locale: z.string().max(10).optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
  })
  .strict();

@ApiTags('Organization Administration')
@Controller()
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  // ── Teams ──

  @Get('teams')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'List teams' })
  listTeams() {
    return this.directory.listTeams();
  }

  @Post('teams')
  @RequirePermissions('team:manage')
  @ApiOperation({ summary: 'Create a team' })
  @ApiZodBody(TeamSchema)
  createTeam(@Body(zodBody(TeamSchema)) body: z.infer<typeof TeamSchema>) {
    return this.directory.createTeam(body);
  }

  @Get('teams/:id')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'Read a team' })
  getTeam(@Param('id') id: string) {
    return this.directory.getTeam(id);
  }

  @Patch('teams/:id')
  @RequirePermissions('team:manage')
  @ApiOperation({ summary: 'Update a team or its roster' })
  @ApiZodBody(TeamSchema.partial())
  updateTeam(
    @Param('id') id: string,
    @Body(zodBody(TeamSchema.partial())) body: Record<string, unknown>,
  ) {
    return this.directory.updateTeam(id, body);
  }

  @Delete('teams/:id')
  @HttpCode(204)
  @RequirePermissions('team:manage')
  @ApiOperation({ summary: 'Delete a team' })
  async deleteTeam(@Param('id') id: string) {
    await this.directory.deleteTeam(id);
  }

  // ── Queues ──

  @Get('queues')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'List queues' })
  listQueues() {
    return this.directory.listQueues();
  }

  @Post('queues')
  @RequirePermissions('queue:manage')
  @ApiOperation({ summary: 'Create a queue' })
  @ApiZodBody(QueueSchema)
  createQueue(@Body(zodBody(QueueSchema)) body: z.infer<typeof QueueSchema>) {
    return this.directory.createQueue(body as never);
  }

  @Get('queues/:id')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'Read a queue' })
  getQueue(@Param('id') id: string) {
    return this.directory.getQueue(id);
  }

  @Patch('queues/:id')
  @RequirePermissions('queue:manage')
  @ApiOperation({ summary: 'Update a queue' })
  @ApiZodBody(QueueSchema.partial())
  updateQueue(
    @Param('id') id: string,
    @Body(zodBody(QueueSchema.partial())) body: Record<string, unknown>,
  ) {
    return this.directory.updateQueue(id, body);
  }

  @Delete('queues/:id')
  @HttpCode(204)
  @RequirePermissions('queue:manage')
  @ApiOperation({ summary: 'Delete an empty queue' })
  async deleteQueue(@Param('id') id: string) {
    await this.directory.deleteQueue(id);
  }

  // ── Business hours ──

  @Get('business-hours')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'List business-hours calendars' })
  listBusinessHours() {
    return this.directory.listBusinessHours();
  }

  @Post('business-hours')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Create a business-hours calendar' })
  @ApiZodBody(BusinessHoursSchema)
  createBusinessHours(
    @Body(zodBody(BusinessHoursSchema)) body: z.infer<typeof BusinessHoursSchema>,
  ) {
    return this.directory.createBusinessHours(body);
  }

  @Patch('business-hours/:id')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Update a business-hours calendar' })
  @ApiZodBody(BusinessHoursSchema.partial())
  updateBusinessHours(
    @Param('id') id: string,
    @Body(zodBody(BusinessHoursSchema.partial())) body: Record<string, unknown>,
  ) {
    return this.directory.updateBusinessHours(id, body as never);
  }

  @Delete('business-hours/:id')
  @HttpCode(204)
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Delete a business-hours calendar' })
  async deleteBusinessHours(@Param('id') id: string) {
    await this.directory.deleteBusinessHours(id);
  }

  @Post('business-hours/:id/holidays')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Add a holiday' })
  @ApiZodBody(HolidaySchema)
  addHoliday(
    @Param('id') id: string,
    @Body(zodBody(HolidaySchema)) body: z.infer<typeof HolidaySchema>,
  ) {
    return this.directory.addHoliday(id, body);
  }

  @Delete('holidays/:id')
  @HttpCode(204)
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Remove a holiday' })
  async deleteHoliday(@Param('id') id: string) {
    await this.directory.deleteHoliday(id);
  }

  // ── Taxonomy ──

  @Get('tags')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'List tags' })
  listTags() {
    return this.directory.listTags();
  }

  @Post('tags')
  @RequirePermissions('taxonomy:manage')
  @ApiOperation({ summary: 'Create a tag' })
  @ApiZodBody(TagSchema)
  createTag(@Body(zodBody(TagSchema)) body: z.infer<typeof TagSchema>) {
    return this.directory.createTag(body);
  }

  @Delete('tags/:id')
  @HttpCode(204)
  @RequirePermissions('taxonomy:manage')
  @ApiOperation({ summary: 'Delete a tag' })
  async deleteTag(@Param('id') id: string) {
    await this.directory.deleteTag(id);
  }

  @Get('custom-fields')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'List custom field definitions' })
  @ApiOptionalQuery('entity')
  listCustomFields(@Query('entity') entity?: string) {
    return this.directory.listCustomFields(entity);
  }

  @Post('custom-fields')
  @RequirePermissions('taxonomy:manage')
  @ApiOperation({ summary: 'Define a custom field' })
  @ApiZodBody(CustomFieldSchema)
  createCustomField(@Body(zodBody(CustomFieldSchema)) body: z.infer<typeof CustomFieldSchema>) {
    return this.directory.createCustomField(body);
  }

  @Delete('custom-fields/:id')
  @HttpCode(204)
  @RequirePermissions('taxonomy:manage')
  @ApiOperation({ summary: 'Delete a custom field definition' })
  async deleteCustomField(@Param('id') id: string) {
    await this.directory.deleteCustomField(id);
  }

  @Get('saved-replies')
  @RequirePermissions('conversation:read')
  @ApiOperation({ summary: 'List saved replies' })
  @ApiOptionalQuery('locale')
  listSavedReplies(@Query('locale') locale?: string) {
    return this.directory.listSavedReplies(locale);
  }

  @Post('saved-replies')
  @RequirePermissions('taxonomy:manage')
  @ApiOperation({ summary: 'Create a saved reply' })
  @ApiZodBody(SavedReplySchema)
  createSavedReply(@Body(zodBody(SavedReplySchema)) body: z.infer<typeof SavedReplySchema>) {
    return this.directory.createSavedReply(body);
  }

  @Patch('saved-replies/:id')
  @RequirePermissions('taxonomy:manage')
  @ApiOperation({ summary: 'Update a saved reply' })
  @ApiZodBody(SavedReplySchema.partial())
  updateSavedReply(
    @Param('id') id: string,
    @Body(zodBody(SavedReplySchema.partial())) body: Record<string, unknown>,
  ) {
    return this.directory.updateSavedReply(id, body);
  }

  @Delete('saved-replies/:id')
  @HttpCode(204)
  @RequirePermissions('taxonomy:manage')
  @ApiOperation({ summary: 'Delete a saved reply' })
  async deleteSavedReply(@Param('id') id: string) {
    await this.directory.deleteSavedReply(id);
  }
}
