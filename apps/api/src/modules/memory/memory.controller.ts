import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { MemoryService } from './memory.service';

@ApiTags('AI Memory')
@Controller('memory')
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get('customers/:id')
  @RequirePermissions('memory:read')
  @ApiOperation({ summary: 'Everything the platform remembers about a customer' })
  forCustomer(@Param('id') id: string) {
    return this.memory.listForCustomer(id);
  }

  @Delete('customers/:id')
  @HttpCode(200)
  @RequirePermissions('memory:delete')
  @ApiOperation({ summary: 'Erase all memory for a customer' })
  async forgetCustomer(@Param('id') id: string) {
    return { removed: await this.memory.forgetCustomer(id) };
  }

  @Post('customers/:id/consent')
  @RequirePermissions('customer:update')
  @ApiOperation({ summary: 'Set AI memory consent; withdrawing it removes identifiable memory already held' })
  setConsent(@Param('id') id: string, @Body(zodBody(z.object({ consent: z.boolean() }).strict())) body: { consent: boolean }) {
    return this.memory.setConsent(id, body.consent);
  }

  @Get('conversations/:id')
  @RequirePermissions('memory:read')
  @ApiOperation({ summary: 'Memory scoped to a conversation' })
  forConversation(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.memory.recall({ conversationId: id, limit: limit ? Number(limit) : undefined });
  }
}
