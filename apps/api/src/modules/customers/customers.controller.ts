import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CursorQuery } from '../../common/pagination';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CustomersService } from './customers.service';

const ContactMethodSchema = z
  .object({
    kind: z.enum(['email', 'phone', 'whatsapp', 'telegram', 'external']),
    value: z.string().min(1).max(320),
    isPrimary: z.boolean().optional(),
  })
  .strict();

const CustomerSchema = z
  .object({
    firstName: z.string().max(80).optional(),
    lastName: z.string().max(80).optional(),
    displayName: z.string().max(160).optional(),
    company: z.string().max(160).optional(),
    jobTitle: z.string().max(120).optional(),
    locale: z.string().max(10).optional(),
    timezone: z.string().max(60).optional(),
    tier: z.string().max(40).optional(),
    tags: z.array(z.string().max(40)).max(50).optional(),
    attributes: z.record(z.unknown()).optional(),
    externalId: z.string().max(120).optional(),
    contactMethods: z.array(ContactMethodSchema).max(20).optional(),
    workspaceId: z.string().optional(),
  })
  .strict();

const SearchQuery = CursorQuery.extend({
  q: z.string().max(160).optional(),
  tier: z.string().max(40).optional(),
  company: z.string().max(160).optional(),
  tags: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
    ),
  segmentId: z.string().optional(),
  sort: z.string().max(80).optional(),
});

const MergeSchema = z.object({ sourceId: z.string().min(3) }).strict();
const NoteSchema = z
  .object({ body: z.string().min(1).max(8000), isPinned: z.boolean().optional() })
  .strict();

const SegmentConditionSchema = z.object({
  field: z.string().min(1).max(80),
  op: z.enum(['eq', 'neq', 'contains', 'in', 'gt', 'lt', 'exists', 'not_exists']),
  value: z.unknown().optional(),
});

const SegmentSchema = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(300).optional(),
    definition: z.object({
      all: z.array(SegmentConditionSchema).max(20).optional(),
      any: z.array(SegmentConditionSchema).max(20).optional(),
    }),
  })
  .strict();

@ApiTags('Customer 360')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'Search customers' })
  search(@Query(zodQuery(SearchQuery)) query: z.infer<typeof SearchQuery>) {
    return this.customers.search(query);
  }

  @Post()
  @RequirePermissions('customer:create')
  @ApiOperation({ summary: 'Create a customer' })
  create(@Body(zodBody(CustomerSchema)) body: z.infer<typeof CustomerSchema>) {
    return this.customers.create(body);
  }

  // Static paths are declared before `:id` so they are not captured by it.

  @Get('segments')
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'List customer segments' })
  listSegments() {
    return this.customers.listSegments();
  }

  @Post('segments')
  @RequirePermissions('customer:update')
  @ApiOperation({ summary: 'Create a customer segment' })
  createSegment(@Body(zodBody(SegmentSchema)) body: z.infer<typeof SegmentSchema>) {
    return this.customers.createSegment(body);
  }

  @Get('segments/:id/count')
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'Count the customers matching a segment' })
  async countSegment(@Param('id') id: string) {
    return { segmentId: id, count: await this.customers.countSegment(id) };
  }

  @Delete('segments/:id')
  @HttpCode(204)
  @RequirePermissions('customer:update')
  @ApiOperation({ summary: 'Delete a segment' })
  async deleteSegment(@Param('id') id: string) {
    await this.customers.deleteSegment(id);
  }

  @Get(':id')
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'Read a customer' })
  get(@Param('id') id: string) {
    return this.customers.get(id);
  }

  @Get(':id/overview')
  @RequirePermissions('customer:read')
  @ApiOperation({
    summary: 'Customer 360 overview: profile, conversations, tickets, notes, activity',
  })
  overview(@Param('id') id: string) {
    return this.customers.overview(id);
  }

  @Get(':id/timeline')
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'Unified customer timeline' })
  timeline(
    @Param('id') id: string,
    @Query(zodQuery(CursorQuery)) query: z.infer<typeof CursorQuery>,
  ) {
    return this.customers.timeline(id, query);
  }

  @Patch(':id')
  @RequirePermissions('customer:update')
  @ApiOperation({ summary: 'Update a customer' })
  update(
    @Param('id') id: string,
    @Body(zodBody(CustomerSchema.partial())) body: Record<string, unknown>,
  ) {
    return this.customers.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('customer:delete')
  @ApiOperation({ summary: 'Delete a customer' })
  async delete(@Param('id') id: string) {
    await this.customers.delete(id);
  }

  @Post(':id/merge')
  @RequirePermissions('customer:merge')
  @ApiOperation({ summary: 'Merge another customer into this one' })
  merge(
    @Param('id') targetId: string,
    @Body(zodBody(MergeSchema)) body: z.infer<typeof MergeSchema>,
  ) {
    return this.customers.merge(body.sourceId, targetId);
  }

  @Post(':id/contact-methods')
  @RequirePermissions('customer:update')
  @ApiOperation({ summary: 'Add a contact method' })
  addContactMethod(
    @Param('id') id: string,
    @Body(zodBody(ContactMethodSchema)) body: z.infer<typeof ContactMethodSchema>,
  ) {
    return this.customers.addContactMethod(id, body);
  }

  @Delete(':id/contact-methods/:methodId')
  @HttpCode(204)
  @RequirePermissions('customer:update')
  @ApiOperation({ summary: 'Remove a contact method' })
  async removeContactMethod(@Param('id') id: string, @Param('methodId') methodId: string) {
    await this.customers.removeContactMethod(id, methodId);
  }

  @Get(':id/notes')
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: 'List customer notes' })
  listNotes(@Param('id') id: string) {
    return this.customers.listNotes(id);
  }

  @Post(':id/notes')
  @RequirePermissions('customer:update')
  @ApiOperation({ summary: 'Add a customer note' })
  addNote(@Param('id') id: string, @Body(zodBody(NoteSchema)) body: z.infer<typeof NoteSchema>) {
    return this.customers.addNote(id, body.body, body.isPinned);
  }

  @Delete(':id/notes/:noteId')
  @HttpCode(204)
  @RequirePermissions('customer:update')
  @ApiOperation({ summary: 'Delete a customer note' })
  async deleteNote(@Param('id') id: string, @Param('noteId') noteId: string) {
    await this.customers.deleteNote(id, noteId);
  }
}
