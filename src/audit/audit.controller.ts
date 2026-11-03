import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole } from '../auth/decorators';
import { AuditService } from './audit.service';
import type { AuditPage } from './audit.types';

@ApiTags('audit-log')
@Controller('audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @MinRole('admin')
  @ApiOperation({
    summary: 'Who did what in this organization (format=json|csv)',
  })
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: Record<string, string | undefined>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuditPage | string> {
    const result = await this.audit.list(auth, query);
    if (typeof result === 'string') {
      response.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="audit-log.csv"',
        'Cache-Control': 'no-store',
      });
    }
    return result;
  }
}
