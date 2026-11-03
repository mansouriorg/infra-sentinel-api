import { Module } from '@nestjs/common';
import { MonitorsModule } from '../monitors/monitors.module';
import { AgentService } from './agent.service';
import { ServerEngine } from './server-engine.service';
import { ServerRulesService } from './server-rules.service';
import {
  AgentController,
  EnrollmentTokensController,
  ServerRulesController,
  ServersController,
} from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  imports: [MonitorsModule],
  controllers: [
    ServersController,
    EnrollmentTokensController,
    ServerRulesController,
    AgentController,
  ],
  providers: [ServersService, AgentService, ServerRulesService, ServerEngine],
  exports: [ServerEngine],
})
export class ServersModule {}
