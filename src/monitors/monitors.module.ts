import { Module } from '@nestjs/common';
import { CheckRunner } from './checks/runner';
import { EventBus } from './event-bus';
import {
  HeartbeatController,
  MonitorsController,
  OverviewController,
  StreamController,
} from './monitors.controller';
import { MonitorsService } from './monitors.service';
import { RecorderService } from './recorder.service';
import { SchedulerService } from './scheduler.service';

@Module({
  controllers: [
    MonitorsController,
    OverviewController,
    HeartbeatController,
    StreamController,
  ],
  providers: [
    EventBus,
    CheckRunner,
    RecorderService,
    SchedulerService,
    MonitorsService,
  ],
  exports: [EventBus, RecorderService, CheckRunner],
})
export class MonitorsModule {}
