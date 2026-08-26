import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CursorQuery } from '../../common/pagination';
import type { Principal } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { RATE_BUCKETS, RateLimit } from '../../core/http/rate-limit.guard';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { AcceptInviteSchema } from '../auth/dto/auth.dto';
import { CurrentOrg, CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { PERMISSIONS, ROLE_KEYS } from '../auth/permissions';
import { IamService } from './iam.service';

const ListUsersQuery = CursorQuery.extend({
  search: z.string().max(120).optional(),
  roleKey: z.enum(ROLE_KEYS).optional(),
  status: z.enum(['invited', 'active', 'suspended', 'deactivated']).optional(),
});

const InviteUserSchema = z
  .object({
    email: z.string().email().toLowerCase().trim(),
    firstName: z.string().min(1).max(80).trim(),
    lastName: z.string().min(1).max(80).trim(),
    roleKey: z.string().min(2).max(40),
    workspaceIds: z.array(z.string()).max(50).optional(),
    skills: z.array(z.string().max(40)).max(50).optional(),
    languages: z.array(z.string().max(10)).max(20).optional(),
  })
  .strict();

const UpdateUserSchema = z
  .object({
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
    roleKey: z.string().min(2).max(40).optional(),
    workspaceIds: z.array(z.string()).max(50).optional(),
    skills: z.array(z.string().max(40)).max(50).optional(),
    languages: z.array(z.string().max(10)).max(20).optional(),
    maxConcurrentChats: z.number().int().min(1).max(50).optional(),
    status: z.enum(['invited', 'active', 'suspended', 'deactivated']).optional(),
    timezone: z.string().optional(),
    locale: z.string().optional(),
  })
  .strict();

const PresenceSchema = z
  .object({
    presence: z.enum(['offline', 'available', 'busy', 'away', 'on_break']),
    note: z.string().max(160).optional(),
  })
  .strict();

const PermissionEnum = z.enum(PERMISSIONS as unknown as [string, ...string[]]);

const CreateRoleSchema = z
  .object({
    key: z
      .string()
      .min(2)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/, 'Use lower case letters, digits and underscores'),
    name: z.string().min(2).max(80),
    description: z.string().max(300).optional(),
    permissions: z.array(PermissionEnum).min(1),
  })
  .strict();

const UpdateRoleSchema = z
  .object({
    name: z.string().min(2).max(80).optional(),
    description: z.string().max(300).optional(),
    permissions: z.array(PermissionEnum).min(1).optional(),
  })
  .strict();

const CreateApiKeySchema = z
  .object({
    name: z.string().min(2).max(80),
    permissions: z.array(PermissionEnum).min(1),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();

@ApiTags('Identity & Access')
@Controller()
export class IamController {
  constructor(private readonly iam: IamService) {}

  // ── Users ──

  @Get('users')
  @RequirePermissions('user:read')
  @ApiOperation({ summary: 'List organization members' })
  async listUsers(@CurrentOrg() organizationId: string, @Query(zodQuery(ListUsersQuery)) query: z.infer<typeof ListUsersQuery>) {
    return this.iam.listUsers(organizationId, query);
  }

  @Get('users/:id')
  @RequirePermissions('user:read')
  @ApiOperation({ summary: 'Read a member' })
  async getUser(@CurrentOrg() organizationId: string, @Param('id') id: string) {
    return this.iam.getUser(organizationId, id);
  }

  @Post('users')
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'Invite a user to the organization' })
  async invite(@Body(zodBody(InviteUserSchema)) body: z.infer<typeof InviteUserSchema>) {
    return this.iam.inviteUser(body);
  }

  @Public()
  @Post('users/accept-invite')
  @RateLimit(RATE_BUCKETS.auth)
  @ApiOperation({ summary: 'Accept an invitation and sign in' })
  async acceptInvite(@Body(zodBody(AcceptInviteSchema)) body: z.infer<typeof AcceptInviteSchema>) {
    return this.iam.acceptInvite(body.token, body);
  }

  @Patch('users/:id')
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'Update a member, their role or workspace scope' })
  async updateUser(
    @CurrentOrg() organizationId: string,
    @Param('id') id: string,
    @Body(zodBody(UpdateUserSchema)) body: z.infer<typeof UpdateUserSchema>,
  ) {
    return this.iam.updateUser(organizationId, id, body);
  }

  @Delete('users/:id')
  @HttpCode(204)
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'Remove a member from the organization' })
  async removeUser(@CurrentOrg() organizationId: string, @Param('id') id: string) {
    await this.iam.removeUser(organizationId, id);
  }

  @Patch('me/presence')
  @ApiOperation({ summary: 'Set your own availability' })
  async setPresence(
    @CurrentUser() principal: Principal | undefined,
    @Body(zodBody(PresenceSchema)) body: z.infer<typeof PresenceSchema>,
  ) {
    if (principal?.type !== 'user') throw AppError.permissionDenied('Presence requires a user session');
    return this.iam.setPresence(principal.id, body.presence, body.note);
  }

  // ── Roles ──

  @Get('roles')
  @RequirePermissions('user:read')
  @ApiOperation({ summary: 'List roles' })
  async listRoles(@CurrentOrg() organizationId: string) {
    return this.iam.listRoles(organizationId);
  }

  @Get('permissions')
  @RequirePermissions('user:read')
  @ApiOperation({ summary: 'The permission catalog' })
  async listPermissions() {
    return PERMISSIONS.map((permission) => {
      const [resource, action] = permission.split(':');
      return { permission, resource, action };
    });
  }

  @Post('roles')
  @RequirePermissions('role:manage')
  @ApiOperation({ summary: 'Create a custom role' })
  async createRole(@Body(zodBody(CreateRoleSchema)) body: z.infer<typeof CreateRoleSchema>) {
    return this.iam.createRole(body as never);
  }

  @Patch('roles/:id')
  @RequirePermissions('role:manage')
  @ApiOperation({ summary: 'Update a role' })
  async updateRole(
    @CurrentOrg() organizationId: string,
    @Param('id') id: string,
    @Body(zodBody(UpdateRoleSchema)) body: z.infer<typeof UpdateRoleSchema>,
  ) {
    return this.iam.updateRole(organizationId, id, body as never);
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @RequirePermissions('role:manage')
  @ApiOperation({ summary: 'Delete a custom role' })
  async deleteRole(@CurrentOrg() organizationId: string, @Param('id') id: string) {
    await this.iam.deleteRole(organizationId, id);
  }

  // ── API keys ──

  @Get('api-keys')
  @RequirePermissions('apikey:manage')
  @ApiOperation({ summary: 'List API keys' })
  async listApiKeys(@CurrentOrg() organizationId: string) {
    return this.iam.listApiKeys(organizationId);
  }

  @Post('api-keys')
  @RequirePermissions('apikey:manage')
  @ApiOperation({ summary: 'Create an API key — the secret is shown only once' })
  async createApiKey(@Body(zodBody(CreateApiKeySchema)) body: z.infer<typeof CreateApiKeySchema>) {
    return this.iam.createApiKey(body as never);
  }

  @Delete('api-keys/:id')
  @HttpCode(204)
  @RequirePermissions('apikey:manage')
  @ApiOperation({ summary: 'Revoke an API key' })
  async revokeApiKey(@CurrentOrg() organizationId: string, @Param('id') id: string) {
    await this.iam.revokeApiKey(organizationId, id);
  }
}
