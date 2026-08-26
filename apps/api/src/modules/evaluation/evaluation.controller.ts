import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { EvaluationService } from './evaluation.service';
import { METRIC_WEIGHTS } from './scorers';

const DatasetSchema = z
  .object({
    name: z.string().min(2).max(120),
    description: z.string().max(500).optional(),
    agentId: z.string().optional(),
    isGate: z.boolean().optional(),
    passThreshold: z.number().min(0).max(1).optional(),
  })
  .strict();

const CaseSchema = z
  .object({
    name: z.string().max(120).optional(),
    input: z.object({ message: z.string().min(1).max(8000) }).passthrough(),
    expectedOutput: z.string().max(8000).optional(),
    expectedContext: z.array(z.string().max(300)).max(20).optional(),
    expectedTools: z.array(z.string().max(80)).max(20).optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
  })
  .strict();

const CasesSchema = z.object({ cases: z.array(CaseSchema).min(1).max(200) }).strict();

const RunSchema = z.object({ agentId: z.string().optional() }).strict();

const RunQuery = z.object({
  datasetId: z.string().optional(),
  agentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

@ApiTags('AI evaluation')
@Controller('evaluation')
export class EvaluationController {
  constructor(private readonly evaluation: EvaluationService) {}

  @Get('metrics')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'Metrics scored on every case, and their weights' })
  metrics() {
    return { weights: METRIC_WEIGHTS };
  }

  // ── Datasets ───────────────────────────────────────────────────────────────

  @Get('datasets')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'List evaluation datasets' })
  listDatasets(@Query('agentId') agentId?: string) {
    return this.evaluation.listDatasets(agentId);
  }

  @Post('datasets')
  @RequirePermissions('eval:manage')
  @ApiOperation({ summary: 'Create an evaluation dataset' })
  createDataset(@Body(zodBody(DatasetSchema)) body: z.infer<typeof DatasetSchema>) {
    return this.evaluation.createDataset(body);
  }

  @Get('datasets/:datasetId')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'Get a dataset with its cases and recent runs' })
  getDataset(@Param('datasetId') datasetId: string) {
    return this.evaluation.getDataset(datasetId);
  }

  @Patch('datasets/:datasetId')
  @RequirePermissions('eval:manage')
  @ApiOperation({ summary: 'Update a dataset' })
  updateDataset(
    @Param('datasetId') datasetId: string,
    @Body(zodBody(DatasetSchema.partial())) body: Partial<z.infer<typeof DatasetSchema>>,
  ) {
    return this.evaluation.updateDataset(datasetId, body);
  }

  @Delete('datasets/:datasetId')
  @HttpCode(204)
  @RequirePermissions('eval:manage')
  @ApiOperation({ summary: 'Delete a dataset and everything scored against it' })
  async deleteDataset(@Param('datasetId') datasetId: string) {
    await this.evaluation.deleteDataset(datasetId);
  }

  // ── Cases ──────────────────────────────────────────────────────────────────

  @Post('datasets/:datasetId/cases')
  @RequirePermissions('eval:manage')
  @ApiOperation({ summary: 'Add cases to a dataset' })
  addCases(
    @Param('datasetId') datasetId: string,
    @Body(zodBody(CasesSchema)) body: z.infer<typeof CasesSchema>,
  ) {
    return this.evaluation.addCases(datasetId, body.cases);
  }

  @Delete('datasets/:datasetId/cases/:caseId')
  @HttpCode(204)
  @RequirePermissions('eval:manage')
  @ApiOperation({ summary: 'Remove a case from a dataset' })
  async deleteCase(@Param('datasetId') datasetId: string, @Param('caseId') caseId: string) {
    await this.evaluation.deleteCase(datasetId, caseId);
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  @Post('datasets/:datasetId/runs')
  @RequirePermissions('eval:manage')
  @ApiOperation({ summary: 'Run a dataset against an agent and score every case' })
  run(
    @Param('datasetId') datasetId: string,
    @Body(zodBody(RunSchema)) body: z.infer<typeof RunSchema>,
  ) {
    return this.evaluation.run(datasetId, body);
  }

  @Get('runs')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'List evaluation runs' })
  listRuns(@Query(zodQuery(RunQuery)) query: z.infer<typeof RunQuery>) {
    return this.evaluation.listRuns(query);
  }

  @Get('runs/:runId')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'Get a run with every case result' })
  getRun(@Param('runId') runId: string) {
    return this.evaluation.getRun(runId);
  }

  @Get('runs/:runId/compare/:candidateRunId')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'Diff two runs, listing regressions first' })
  compare(@Param('runId') runId: string, @Param('candidateRunId') candidateRunId: string) {
    return this.evaluation.compare(runId, candidateRunId);
  }
}
