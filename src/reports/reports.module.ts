import { Module } from '@nestjs/common';
import { DigestService } from './digest.service';
import { ReportService } from './report.service';
import { ReportsController } from './reports.controller';

@Module({
  controllers: [ReportsController],
  providers: [ReportService, DigestService],
  exports: [ReportService, DigestService],
})
export class ReportsModule {}
