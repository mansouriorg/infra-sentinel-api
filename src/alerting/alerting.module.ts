import { Module } from '@nestjs/common';
import { MonitorsModule } from '../monitors/monitors.module';
import { AlertEngine } from './alert-engine.service';
import {
  AlertRulesController,
  ChannelsController,
  IncidentsController,
  MaintenanceController,
  PoliciesController,
  SchedulesController,
  SilencesController,
} from './alerting.controller';
import { ChannelsService } from './channels.service';
import { IncidentsService } from './incidents.service';
import { RoutingService } from './routing.service';
import { SuppressionService } from './suppression.service';

@Module({
  imports: [MonitorsModule],
  controllers: [
    ChannelsController,
    AlertRulesController,
    PoliciesController,
    SchedulesController,
    SilencesController,
    MaintenanceController,
    IncidentsController,
  ],
  providers: [
    ChannelsService,
    RoutingService,
    SuppressionService,
    IncidentsService,
    AlertEngine,
  ],
  exports: [AlertEngine],
})
export class AlertingModule {}
