import { Body, Controller, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AppError } from '../../core/errors/app-error';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { ApiZodBody } from '../../core/http/zod-openapi';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { HybridService } from './hybrid.service';
import { checkResidency } from './residency';

const RegisterSchema = z
  .object({
    name: z.string().min(2).max(80),
    region: z.string().min(2).max(40),
    organizationIds: z.array(z.string()).max(500).optional(),
    config: z.record(z.unknown()).optional(),
  })
  .strict();

const HeartbeatSchema = z
  .object({
    version: z.string().max(40).optional(),
    status: z.enum(['healthy', 'degraded']).optional(),
    uptimeSeconds: z.number().int().min(0).optional(),
    metrics: z.record(z.unknown()).optional(),
  })
  .strict();

@ApiTags('Hybrid deployment')
@Controller('hybrid')
export class HybridController {
  constructor(private readonly hybrid: HybridService) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'What this deployment is — mode, region, contract version' })
  status() {
    return this.hybrid.status();
  }

  /**
   * Unauthenticated by necessity: a data plane holds an enrollment token, not
   * a platform session. The token is the credential, and it identifies exactly
   * one plane.
   */
  @Public()
  @Post('heartbeat')
  @ApiOperation({ summary: 'Receive a data plane heartbeat and return its configuration' })
  @ApiZodBody(HeartbeatSchema)
  heartbeat(
    @Headers('authorization') authorization: string | undefined,
    @Body(zodBody(HeartbeatSchema)) body: z.infer<typeof HeartbeatSchema>,
  ) {
    if (!authorization?.startsWith('Bearer dpt_'))
      throw AppError.unauthenticated('A data plane heartbeat needs its enrollment token');
    return this.hybrid.receiveHeartbeat(authorization.slice(7), body);
  }

  @Post('residency-check')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Check whether a payload could legally cross the boundary' })
  residency(@Body() body: unknown) {
    return checkResidency(body);
  }

  // ── Control plane operations ───────────────────────────────────────────────

  @Get('data-planes')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'List data planes and whether they are reporting' })
  list() {
    return this.hybrid.listDataPlanes();
  }

  @Post('data-planes')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Register a data plane; its enrollment token is shown once' })
  @ApiZodBody(RegisterSchema)
  register(@Body(zodBody(RegisterSchema)) body: z.infer<typeof RegisterSchema>) {
    return this.hybrid.registerDataPlane(body);
  }

  @Get('data-planes/:planeId')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Get a data plane with its recent heartbeats' })
  get(@Param('planeId') planeId: string) {
    return this.hybrid.getDataPlane(planeId);
  }

  @Patch('data-planes/:planeId/config')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Set the configuration a plane pulls on its next heartbeat' })
  updateConfig(@Param('planeId') planeId: string, @Body() body: Record<string, unknown>) {
    return this.hybrid.updateConfig(planeId, body);
  }

  @Post('data-planes/:planeId/suspend')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Stop accepting heartbeats from a plane' })
  suspend(@Param('planeId') planeId: string) {
    return this.hybrid.suspendDataPlane(planeId, true);
  }

  @Post('data-planes/:planeId/resume')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Accept heartbeats again' })
  resume(@Param('planeId') planeId: string) {
    return this.hybrid.suspendDataPlane(planeId, false);
  }
}
