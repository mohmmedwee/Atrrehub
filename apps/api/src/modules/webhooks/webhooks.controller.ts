import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { ApiOptionalQuery, ApiZodBody } from '../../core/http/zod-openapi';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { WebhooksService } from './webhooks.service';

const EndpointSchema = z
  .object({
    name: z.string().min(2).max(80),
    url: z.string().url().max(2000),
    events: z.array(z.string().min(1).max(80)).min(1).max(100),
    isActive: z.boolean().optional(),
  })
  .strict();

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('events')
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'Event types an endpoint can subscribe to' })
  catalogue() {
    return this.webhooks.catalogue();
  }

  @Get('deliveries')
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'Recent delivery attempts across every endpoint' })
  @ApiOptionalQuery('endpointId', 'status', 'limit')
  deliveries(
    @Query('endpointId') endpointId?: string,
    @Query('status') status?: 'delivered' | 'pending' | 'failed',
    @Query('limit') limit?: string,
  ) {
    return this.webhooks.deliveries({
      endpointId,
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('deliveries/:deliveryId')
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'One delivery, including the payload that was sent' })
  delivery(@Param('deliveryId') deliveryId: string) {
    return this.webhooks.delivery(deliveryId);
  }

  @Post('deliveries/:deliveryId/replay')
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'Send the same event again as a new delivery' })
  replay(@Param('deliveryId') deliveryId: string) {
    return this.webhooks.replay(deliveryId);
  }

  @Get()
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'List endpoints' })
  list() {
    return this.webhooks.list();
  }

  @Post()
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'Register an endpoint; the signing secret is returned once' })
  @ApiZodBody(EndpointSchema)
  create(@Body(zodBody(EndpointSchema)) body: z.infer<typeof EndpointSchema>) {
    return this.webhooks.create(body);
  }

  @Get(':endpointId')
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'Get an endpoint' })
  get(@Param('endpointId') endpointId: string) {
    return this.webhooks.get(endpointId);
  }

  @Patch(':endpointId')
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'Reconfigure an endpoint; re-enabling clears its failure count' })
  @ApiZodBody(EndpointSchema.partial())
  update(
    @Param('endpointId') endpointId: string,
    @Body(zodBody(EndpointSchema.partial())) body: Partial<z.infer<typeof EndpointSchema>>,
  ) {
    return this.webhooks.update(endpointId, body);
  }

  @Post(':endpointId/rotate-secret')
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'Issue a new signing secret; it is returned once' })
  rotate(@Param('endpointId') endpointId: string) {
    return this.webhooks.rotateSecret(endpointId);
  }

  @Post(':endpointId/ping')
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'Send a synthetic event to confirm the endpoint works' })
  ping(@Param('endpointId') endpointId: string) {
    return this.webhooks.ping(endpointId);
  }

  @Delete(':endpointId')
  @HttpCode(204)
  @RequirePermissions('webhook:manage')
  @ApiOperation({ summary: 'Remove an endpoint and its delivery history' })
  remove(@Param('endpointId') endpointId: string) {
    return this.webhooks.remove(endpointId);
  }
}
