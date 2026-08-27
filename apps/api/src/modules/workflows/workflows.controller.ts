import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { ApiZodBody } from '../../core/http/zod-openapi';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { NODE_TYPES } from './graph';
import { WorkflowsService } from './workflows.service';

const NodeSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(Object.keys(NODE_TYPES) as [string, ...string[]]),
  name: z.string().max(120).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  config: z.record(z.unknown()).default({}),
});

const EdgeSchema = z.object({
  id: z.string().min(1).max(80),
  from: z.string().min(1).max(80),
  to: z.string().min(1).max(80),
  branch: z.string().max(60).optional(),
  condition: z.string().max(1000).optional(),
});

const GraphSchema = z.object({
  nodes: z.array(NodeSchema).max(200),
  edges: z.array(EdgeSchema).max(400),
});

const CreateSchema = z
  .object({
    name: z.string().min(2).max(80),
    key: z
      .string()
      .min(2)
      .max(60)
      .regex(/^[a-z][a-z0-9_-]*$/),
    description: z.string().max(500).optional(),
    graph: GraphSchema.optional(),
    workspaceId: z.string().optional(),
  })
  .strict();

@ApiTags('Workflows')
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get('node-catalog')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'The node palette for the visual builder' })
  catalog() {
    return this.workflows.nodeCatalog();
  }

  @Get()
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'List workflows' })
  list() {
    return this.workflows.list();
  }

  @Post()
  @RequirePermissions('workflow:manage')
  @ApiOperation({ summary: 'Create a workflow' })
  @ApiZodBody(CreateSchema)
  create(@Body(zodBody(CreateSchema)) body: z.infer<typeof CreateSchema>) {
    return this.workflows.create(body as never);
  }

  @Get(':id')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'Read a workflow with its latest graph and validation issues' })
  get(@Param('id') id: string) {
    return this.workflows.get(id);
  }

  @Put(':id/graph')
  @RequirePermissions('workflow:manage')
  @ApiOperation({ summary: 'Save the graph and return validation issues' })
  @ApiZodBody(GraphSchema)
  saveGraph(
    @Param('id') id: string,
    @Body(zodBody(GraphSchema)) body: z.infer<typeof GraphSchema>,
  ) {
    return this.workflows.saveGraph(id, body as never);
  }

  @Get(':id/validate')
  @RequirePermissions('agent:read')
  @ApiOperation({ summary: 'Validate the latest graph' })
  validate(@Param('id') id: string) {
    return this.workflows.validate(id);
  }

  @Post(':id/publish')
  @RequirePermissions('workflow:manage')
  @ApiOperation({ summary: 'Publish the latest version' })
  publish(@Param('id') id: string) {
    return this.workflows.publish(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('workflow:manage')
  @ApiOperation({ summary: 'Delete a workflow' })
  async delete(@Param('id') id: string) {
    await this.workflows.delete(id);
  }
}
