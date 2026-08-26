import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { IntegrationsService } from './integrations.service';

const KindEnum = z.enum([
  'salesforce',
  'dynamics',
  'hubspot',
  'rest',
  'graphql',
  'webhook',
  'custom',
]);

const ConfigSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    auth: z.enum(['bearer', 'api_key_header', 'basic', 'query_param', 'none']).optional(),
    authParam: z.string().max(60).optional(),
    contactsPath: z.string().max(500).optional(),
    recordsPath: z.string().max(200).optional(),
    nextPath: z.string().max(200).optional(),
    cursorParam: z.string().max(60).optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
    pageSizeParam: z.string().max(60).optional(),
    query: z.record(z.string().max(2000)).optional(),
    headers: z.record(z.string().max(500)).optional(),
  })
  .strict();

const IntegrationSchema = z
  .object({
    kind: KindEnum,
    name: z.string().min(2).max(80),
    credentials: z.record(z.string().max(4000)).optional(),
    config: ConfigSchema.optional(),
    fieldMapping: z.record(z.string().max(60)).optional(),
    workspaceId: z.string().optional(),
  })
  .strict();

@ApiTags('Integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('catalogue')
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Providers on offer, with the credentials each needs' })
  catalogue() {
    return this.integrations.catalogue();
  }

  @Get()
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'List integrations and their connection status' })
  list() {
    return this.integrations.list();
  }

  @Post()
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Connect a provider; it stays disabled until tested' })
  create(@Body(zodBody(IntegrationSchema)) body: z.infer<typeof IntegrationSchema>) {
    return this.integrations.create(body);
  }

  @Get(':integrationId')
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Get an integration' })
  get(@Param('integrationId') integrationId: string) {
    return this.integrations.get(integrationId);
  }

  @Patch(':integrationId')
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Reconfigure an integration; changing how it connects re-tests it' })
  update(
    @Param('integrationId') integrationId: string,
    @Body(zodBody(IntegrationSchema.partial())) body: Partial<z.infer<typeof IntegrationSchema>>,
  ) {
    return this.integrations.update(integrationId, body);
  }

  @Delete(':integrationId')
  @HttpCode(204)
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Remove an integration' })
  async delete(@Param('integrationId') integrationId: string) {
    await this.integrations.delete(integrationId);
  }

  @Post(':integrationId/test')
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Probe the provider and report the fields it actually returns' })
  test(@Param('integrationId') integrationId: string) {
    return this.integrations.test(integrationId);
  }

  @Post(':integrationId/enable')
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Enable syncing; requires a successful test' })
  enable(@Param('integrationId') integrationId: string) {
    return this.integrations.setActive(integrationId, true);
  }

  @Post(':integrationId/disable')
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Stop syncing without discarding the configuration' })
  disable(@Param('integrationId') integrationId: string) {
    return this.integrations.setActive(integrationId, false);
  }

  @Post(':integrationId/sync')
  @RequirePermissions('integration:manage')
  @ApiOperation({ summary: 'Pull contacts now and reconcile them into Customer 360' })
  sync(@Param('integrationId') integrationId: string) {
    return this.integrations.sync(integrationId);
  }
}
