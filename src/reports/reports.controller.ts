import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole, Scope } from '../auth/decorators';
import { DigestService, type DigestView } from './digest.service';
import { incidentsCsv, reportFileName, subjectsCsv } from './report.csv';
import { renderReportPdf } from './report.pdf';
import { ReportService } from './report.service';
import type { SlaReport } from './report.types';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportService,
    private readonly digest: DigestService,
  ) {}

  @Get('sla')
  @MinRole('viewer')
  @Scope('reports:read')
  @ApiOperation({
    summary:
      'SLA report as JSON, CSV or PDF (format=json|csv|csv-incidents|pdf)',
  })
  async sla(
    @CurrentAuth() auth: AuthContext,
    @Query() query: Record<string, string | undefined>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SlaReport | string | StreamableFile> {
    const parsed = this.reports.parseQuery(query);
    const report = await this.reports.build(auth.orgId, parsed);
    const attachment = (type: string, name: string) =>
      response.set({
        'Content-Type': type,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      });
    if (parsed.format === 'csv') {
      attachment('text/csv; charset=utf-8', reportFileName(report, 'csv'));
      return subjectsCsv(report);
    }
    if (parsed.format === 'csv-incidents') {
      attachment(
        'text/csv; charset=utf-8',
        reportFileName(report, 'csv', '-incidents'),
      );
      return incidentsCsv(report);
    }
    if (parsed.format === 'pdf') {
      attachment('application/pdf', reportFileName(report, 'pdf'));
      return new StreamableFile(renderReportPdf(report));
    }
    return report;
  }

  @Get('digest')
  @MinRole('viewer')
  @ApiOperation({ summary: 'Weekly digest settings' })
  getDigest(@CurrentAuth() auth: AuthContext): Promise<DigestView> {
    return this.digest.get(auth);
  }

  @Put('digest')
  @MinRole('admin')
  @ApiOperation({ summary: 'Change the weekly digest settings' })
  putDigest(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<DigestView> {
    return this.digest.update(auth, body);
  }

  @Post('digest/test')
  @HttpCode(200)
  @MinRole('admin')
  @ApiOperation({ summary: 'Send the digest for the last 7 days to yourself' })
  testDigest(
    @CurrentAuth() auth: AuthContext,
  ): Promise<{ sent: boolean; to: string }> {
    return this.digest.sendTest(auth);
  }
}
