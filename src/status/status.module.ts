import { Module } from '@nestjs/common';
import { DomainService } from './domain.service';
import { PagesService } from './pages.service';
import { PublicStatusController } from './public.controller';
import { PublicStatusService } from './public.service';
import {
  IncidentStatusController,
  StatusPagesController,
} from './status.controller';
import { StatusMailer } from './status-mailer.service';
import { UpdatesService } from './updates.service';

@Module({
  controllers: [
    StatusPagesController,
    IncidentStatusController,
    PublicStatusController,
  ],
  providers: [
    DomainService,
    PublicStatusService,
    PagesService,
    UpdatesService,
    StatusMailer,
  ],
  exports: [DomainService, PublicStatusService],
})
export class StatusModule {}
