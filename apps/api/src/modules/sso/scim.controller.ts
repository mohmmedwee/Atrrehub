import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ScimService } from './scim.service';

/**
 * SCIM 2.0, mounted outside the versioned API because identity providers are
 * configured with a `/scim/v2` base URL and will not accept another shape.
 *
 * Every response is sent raw rather than through the usual envelope: a
 * provider parses these bodies against the specification, and a `{ data: … }`
 * wrapper would make every resource unreadable to it.
 */
@ApiTags('SCIM')
@Controller('scim/v2')
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  private send(reply: FastifyReply, status: number, body: unknown) {
    return reply.status(status).header('content-type', 'application/scim+json').send(body);
  }

  @Get('Users')
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'List provisioned users' })
  async listUsers(
    @Res() reply: FastifyReply,
    @Query('filter') filter?: string,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
  ) {
    const result = await this.scim.listUsers({
      filter,
      startIndex: startIndex ? Number(startIndex) : undefined,
      count: count ? Number(count) : undefined,
    });
    return this.send(reply, 200, result);
  }

  @Get('Users/:userId')
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'Get one provisioned user' })
  async getUser(@Param('userId') userId: string, @Res() reply: FastifyReply) {
    return this.send(reply, 200, await this.scim.getUser(userId));
  }

  @Post('Users')
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'Provision a user' })
  async createUser(@Body() body: Record<string, unknown>, @Res() reply: FastifyReply) {
    return this.send(reply, 201, await this.scim.createUser(body ?? {}));
  }

  @Put('Users/:userId')
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'Replace a user' })
  async replaceUser(
    @Param('userId') userId: string,
    @Body() body: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ) {
    return this.send(reply, 200, await this.scim.replaceUser(userId, body ?? {}));
  }

  @Patch('Users/:userId')
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'Patch a user — usually to deactivate a leaver' })
  async patchUser(
    @Param('userId') userId: string,
    @Body() body: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ) {
    return this.send(reply, 200, await this.scim.patchUser(userId, body ?? {}));
  }

  @Delete('Users/:userId')
  @HttpCode(204)
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'Deprovision a user' })
  async deleteUser(@Param('userId') userId: string, @Res() reply: FastifyReply) {
    await this.scim.deleteUser(userId);
    return reply.status(204).send();
  }

  @Get('Groups')
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'List groups — the organization’s roles, read-only' })
  async listGroups(
    @Res() reply: FastifyReply,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
  ) {
    const result = await this.scim.listGroups({
      startIndex: startIndex ? Number(startIndex) : undefined,
      count: count ? Number(count) : undefined,
    });
    return this.send(reply, 200, result);
  }
}
