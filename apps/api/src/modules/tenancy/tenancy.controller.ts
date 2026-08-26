import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { CurrentOrg } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { TenancyService } from './tenancy.service';

const UpdateOrganizationSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    logoUrl: z.string().url().nullable().optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex colour such as #2563eb')
      .nullable()
      .optional(),
    timezone: z.string().optional(),
    locale: z.string().optional(),
    defaultLanguage: z.string().optional(),
    supportEmail: z.string().email().nullable().optional(),
    settings: z.record(z.unknown()).optional(),
    aiSettings: z.record(z.unknown()).optional(),
  })
  .strict();

const CreateWorkspaceSchema = z
  .object({
    name: z.string().min(2).max(80),
    slug: z.string().min(2).max(60).optional(),
    description: z.string().max(500).optional(),
    environment: z.enum(['development', 'staging', 'production']).default('production'),
  })
  .strict();

const UpdateWorkspaceSchema = CreateWorkspaceSchema.partial().strict();

@ApiTags('Organization')
@Controller()
export class TenancyController {
  constructor(private readonly tenancy: TenancyService) {}

  @Get('organization')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'Read the current organization' })
  async organization(@CurrentOrg() organizationId: string) {
    return this.tenancy.getOrganization(organizationId);
  }

  @Patch('organization')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Update organization profile, branding and localization' })
  async updateOrganization(
    @CurrentOrg() organizationId: string,
    @Body(zodBody(UpdateOrganizationSchema)) body: z.infer<typeof UpdateOrganizationSchema>,
  ) {
    return this.tenancy.updateOrganization(organizationId, body);
  }

  @Get('workspaces')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'List workspaces' })
  async listWorkspaces(@CurrentOrg() organizationId: string) {
    return this.tenancy.listWorkspaces(organizationId);
  }

  @Post('workspaces')
  @RequirePermissions('workspace:manage')
  @ApiOperation({ summary: 'Create a workspace' })
  async createWorkspace(
    @Body(zodBody(CreateWorkspaceSchema)) body: z.infer<typeof CreateWorkspaceSchema>,
  ) {
    return this.tenancy.createWorkspace(body);
  }

  @Get('workspaces/:id')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'Read a workspace' })
  async getWorkspace(@Param('id') id: string) {
    return this.tenancy.getWorkspace(id);
  }

  @Patch('workspaces/:id')
  @RequirePermissions('workspace:manage')
  @ApiOperation({ summary: 'Update a workspace' })
  async updateWorkspace(
    @Param('id') id: string,
    @Body(zodBody(UpdateWorkspaceSchema)) body: z.infer<typeof UpdateWorkspaceSchema>,
  ) {
    return this.tenancy.updateWorkspace(id, body);
  }

  @Delete('workspaces/:id')
  @HttpCode(204)
  @RequirePermissions('workspace:manage')
  @ApiOperation({ summary: 'Delete a workspace' })
  async deleteWorkspace(@Param('id') id: string) {
    await this.tenancy.deleteWorkspace(id);
  }
}
