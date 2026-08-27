import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { ApiZodBody } from '../../core/http/zod-openapi';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ReportsService } from './reports.service';

const FilterSchema = z
  .object({
    field: z.string().min(1).max(60),
    operator: z.enum(['is', 'is_not', 'in', 'not_in', 'is_set', 'is_not_set']),
    value: z
      .union([z.string().max(200), z.array(z.string().max(200)).max(50), z.boolean()])
      .optional(),
  })
  .strict();

const DefinitionSchema = z
  .object({
    source: z.string().min(1).max(40),
    metrics: z.array(z.string().max(60)).min(1).max(10),
    dimensions: z.array(z.string().max(60)).max(3).optional(),
    bucket: z.enum(['day', 'week', 'month']).optional(),
    filters: z.array(FilterSchema).max(10).optional(),
    range: z
      .object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        lastDays: z.number().int().min(1).max(730).optional(),
      })
      .optional(),
    sort: z.object({ column: z.string().max(60), direction: z.enum(['asc', 'desc']) }).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

const ReportSchema = z
  .object({
    name: z.string().min(2).max(120),
    description: z.string().max(500).optional(),
    definition: DefinitionSchema,
    visualization: z.enum(['table', 'line', 'bar', 'pie', 'number']).optional(),
    scheduleCron: z.string().max(120).nullable().optional(),
    recipients: z.array(z.string().email()).max(50).optional(),
    format: z.enum(['csv', 'json']).optional(),
  })
  .strict();

@ApiTags('Reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sources')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Sources a report can be built from, with their metrics and filters' })
  catalogue() {
    return this.reports.catalogue();
  }

  @Post('run')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Run an ad-hoc report definition without saving it' })
  @ApiZodBody(DefinitionSchema)
  runAdHoc(@Body(zodBody(DefinitionSchema)) body: z.infer<typeof DefinitionSchema>) {
    return this.reports.run(body);
  }

  @Get()
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'List saved reports' })
  list() {
    return this.reports.list();
  }

  @Post()
  @RequirePermissions('report:manage')
  @ApiOperation({ summary: 'Save a report definition' })
  @ApiZodBody(ReportSchema)
  create(@Body(zodBody(ReportSchema)) body: z.infer<typeof ReportSchema>) {
    return this.reports.create(body);
  }

  @Get(':reportId')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Get a saved report' })
  get(@Param('reportId') reportId: string) {
    return this.reports.get(reportId);
  }

  @Patch(':reportId')
  @RequirePermissions('report:manage')
  @ApiOperation({ summary: 'Update a saved report' })
  @ApiZodBody(ReportSchema.partial())
  update(
    @Param('reportId') reportId: string,
    @Body(zodBody(ReportSchema.partial())) body: Partial<z.infer<typeof ReportSchema>>,
  ) {
    return this.reports.update(reportId, body);
  }

  @Delete(':reportId')
  @HttpCode(204)
  @RequirePermissions('report:manage')
  @ApiOperation({ summary: 'Delete a saved report' })
  async delete(@Param('reportId') reportId: string) {
    await this.reports.delete(reportId);
  }

  @Post(':reportId/run')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Run a saved report' })
  run(@Param('reportId') reportId: string) {
    return this.reports.runSaved(reportId);
  }

  @Get(':reportId/export.csv')
  @RequirePermissions('report:export')
  @ApiOperation({ summary: 'Run a saved report and download it as CSV' })
  async exportCsv(@Param('reportId') reportId: string, @Res() reply: FastifyReply) {
    const report = await this.reports.get(reportId);
    const result = await this.reports.runSaved(reportId);
    const filename = `${report.name.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv`;

    // A CSV is a file, not an envelope: the response interceptor is bypassed so
    // the body is exactly what a spreadsheet expects.
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(this.reports.toCsv(result));
  }
}
