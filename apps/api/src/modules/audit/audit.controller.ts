import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodQuery } from '../../core/http/zod-validation.pipe';
import { CurrentOrg } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { AuditService } from './audit.service';

const SearchQuery = z.object({
  actorId: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

@ApiTags('Audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit:read')
  @ApiOperation({ summary: 'Search the audit trail' })
  async search(
    @CurrentOrg() organizationId: string,
    @Query(zodQuery(SearchQuery)) query: z.infer<typeof SearchQuery>,
  ) {
    return this.audit.search({ organizationId, ...query });
  }
}
