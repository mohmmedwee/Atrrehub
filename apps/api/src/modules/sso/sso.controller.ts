import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody, zodQuery } from '../../core/http/zod-validation.pipe';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { SsoService } from './sso.service';

const ConnectionSchema = z
  .object({
    domain: z.string().min(3).max(200),
    issuer: z.string().url(),
    authorizationEndpoint: z.string().url(),
    tokenEndpoint: z.string().url(),
    jwksUri: z.string().url(),
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(500),
    scopes: z.array(z.string().max(60)).max(20).optional(),
    groupsClaim: z.string().max(60).optional(),
    groupRoleMapping: z
      .array(z.object({ group: z.string().min(1).max(200), roleKey: z.string().min(1).max(40) }))
      .max(50)
      .optional(),
    defaultRoleKey: z.string().max(40).optional(),
    allowJitProvisioning: z.boolean().optional(),
  })
  .strict();

const DiscoverQuery = z.object({ email: z.string().email() });

const BeginSchema = z.object({ redirectUri: z.string().url() }).strict();

const CallbackSchema = z
  .object({ state: z.string().min(8).max(200), code: z.string().min(1).max(4000) })
  .strict();

@ApiTags('SSO')
@Controller('sso')
export class SsoController {
  constructor(private readonly sso: SsoService) {}

  // ── Login (unauthenticated by necessity) ───────────────────────────────────

  @Public()
  @Get('discover')
  @ApiOperation({ summary: 'Whether an email domain is routed to SSO' })
  discover(@Query(zodQuery(DiscoverQuery)) query: z.infer<typeof DiscoverQuery>) {
    return this.sso.discover(query.email);
  }

  @Public()
  @Post('connections/:connectionId/authorize')
  @ApiOperation({ summary: 'Begin a login; returns the provider URL to redirect to' })
  begin(
    @Param('connectionId') connectionId: string,
    @Body(zodBody(BeginSchema)) body: z.infer<typeof BeginSchema>,
  ) {
    return this.sso.begin(connectionId, body.redirectUri);
  }

  @Public()
  @Post('callback')
  @ApiOperation({ summary: 'Complete a login and exchange it for platform tokens' })
  callback(@Body(zodBody(CallbackSchema)) body: z.infer<typeof CallbackSchema>) {
    return this.sso.complete(body.state, body.code);
  }

  // ── Administration ─────────────────────────────────────────────────────────

  @Get('connections')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'List SSO connections' })
  list() {
    return this.sso.list();
  }

  @Post('connections')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Add an OIDC connection for an email domain' })
  create(@Body(zodBody(ConnectionSchema)) body: z.infer<typeof ConnectionSchema>) {
    return this.sso.create(body);
  }

  @Get('connections/:connectionId')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Get an SSO connection' })
  get(@Param('connectionId') connectionId: string) {
    return this.sso.get(connectionId);
  }

  @Patch('connections/:connectionId')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Update an SSO connection' })
  update(
    @Param('connectionId') connectionId: string,
    @Body(zodBody(ConnectionSchema.partial())) body: Partial<z.infer<typeof ConnectionSchema>>,
  ) {
    return this.sso.update(connectionId, body);
  }

  @Post('connections/:connectionId/enable')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Enable the connection; the provider keys must be reachable first' })
  enable(@Param('connectionId') connectionId: string) {
    return this.sso.setEnabled(connectionId, true);
  }

  @Post('connections/:connectionId/disable')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Disable the connection and return the domain to passwords' })
  disable(@Param('connectionId') connectionId: string) {
    return this.sso.setEnabled(connectionId, false);
  }

  @Post('connections/:connectionId/scim-token')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Issue or rotate the SCIM bearer token; shown once' })
  rotateScimToken(@Param('connectionId') connectionId: string) {
    return this.sso.rotateScimToken(connectionId);
  }

  @Delete('connections/:connectionId')
  @HttpCode(204)
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Remove an SSO connection' })
  async delete(@Param('connectionId') connectionId: string) {
    await this.sso.delete(connectionId);
  }
}
