import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { zodBody } from '../../core/http/zod-validation.pipe';
import { ApiZodBody } from '../../core/http/zod-openapi';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { BackupService } from './backup.service';

const BackupSchema = z
  .object({
    kind: z.enum(['full', 'schema_only']).optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();

@ApiTags('Disaster recovery')
@Controller('dr')
export class DrController {
  constructor(private readonly backups: BackupService) {}

  @Get('readiness')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Is there a backup, is it recent, and has anyone proved it restores?' })
  readiness() {
    return this.backups.readiness();
  }

  @Get('backups')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'List backups and their verification status' })
  list() {
    return this.backups.list();
  }

  @Post('backups')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Take a backup now' })
  @ApiZodBody(BackupSchema)
  create(@Body(zodBody(BackupSchema)) body: z.infer<typeof BackupSchema>) {
    return this.backups.create(body);
  }

  @Get('backups/:backupId')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Get a backup with its verification checks' })
  get(@Param('backupId') backupId: string) {
    return this.backups.get(backupId);
  }

  @Post('backups/:backupId/verify')
  @RequirePermissions('organization:manage')
  @ApiOperation({ summary: 'Restore into a scratch database and check what came back' })
  verify(@Param('backupId') backupId: string) {
    return this.backups.verify(backupId);
  }
}
