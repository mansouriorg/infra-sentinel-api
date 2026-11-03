import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole, Scope } from '../auth/decorators';
import type {
  ChannelView,
  IncidentDetail,
  IncidentSummary,
  IncidentView,
  MaintenanceView,
  PolicyView,
  RuleView,
  ScheduleView,
  SilenceView,
} from './alert.types';
import { ChannelsService } from './channels.service';
import { IncidentsService } from './incidents.service';
import { RoutingService } from './routing.service';
import { SuppressionService } from './suppression.service';

@ApiTags('alerting')
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @MinRole('viewer')
  @ApiOperation({ summary: 'Notification channels, secrets are masked' })
  list(@CurrentAuth() auth: AuthContext): Promise<ChannelView[]> {
    return this.channels.list(auth);
  }

  @Post('test')
  @HttpCode(200)
  @MinRole('admin')
  @ApiOperation({
    summary: 'Send a test message to a saved or unsaved channel',
  })
  test(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.channels.test(auth, body);
  }

  @Post()
  @MinRole('admin')
  @ApiOperation({ summary: 'Create a notification channel' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<ChannelView> {
    return this.channels.create(auth, body);
  }

  @Patch(':id')
  @MinRole('admin')
  @ApiOperation({ summary: 'Update a notification channel' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ChannelView> {
    return this.channels.update(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('admin')
  @ApiOperation({ summary: 'Delete a notification channel that nothing uses' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.channels.remove(auth, id);
  }
}

@ApiTags('alerting')
@Controller('alert-rules')
export class AlertRulesController {
  constructor(private readonly routing: RoutingService) {}

  @Get()
  @MinRole('viewer')
  @ApiOperation({ summary: 'Alert rules' })
  list(@CurrentAuth() auth: AuthContext): Promise<RuleView[]> {
    return this.routing.listRules(auth);
  }

  @Post()
  @MinRole('admin')
  @ApiOperation({ summary: 'Create an alert rule' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<RuleView> {
    return this.routing.createRule(auth, body);
  }

  @Patch(':id')
  @MinRole('admin')
  @ApiOperation({ summary: 'Update an alert rule' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<RuleView> {
    return this.routing.updateRule(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('admin')
  @ApiOperation({ summary: 'Delete an alert rule' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.routing.removeRule(auth, id);
  }
}

@ApiTags('alerting')
@Controller('escalation-policies')
export class PoliciesController {
  constructor(private readonly routing: RoutingService) {}

  @Get()
  @MinRole('viewer')
  @ApiOperation({ summary: 'Escalation policies' })
  list(@CurrentAuth() auth: AuthContext): Promise<PolicyView[]> {
    return this.routing.listPolicies(auth);
  }

  @Post()
  @MinRole('admin')
  @ApiOperation({ summary: 'Create an escalation policy' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<PolicyView> {
    return this.routing.createPolicy(auth, body);
  }

  @Patch(':id')
  @MinRole('admin')
  @ApiOperation({ summary: 'Update an escalation policy' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PolicyView> {
    return this.routing.updatePolicy(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('admin')
  @ApiOperation({ summary: 'Delete an escalation policy that no rule uses' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.routing.removePolicy(auth, id);
  }
}

@ApiTags('alerting')
@Controller('oncall-schedules')
export class SchedulesController {
  constructor(private readonly routing: RoutingService) {}

  @Get()
  @MinRole('viewer')
  @ApiOperation({ summary: 'On-call schedules with who is on call now' })
  list(@CurrentAuth() auth: AuthContext): Promise<ScheduleView[]> {
    return this.routing.listSchedules(auth);
  }

  @Post()
  @MinRole('admin')
  @ApiOperation({ summary: 'Create an on-call schedule' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<ScheduleView> {
    return this.routing.createSchedule(auth, body);
  }

  @Patch(':id')
  @MinRole('admin')
  @ApiOperation({ summary: 'Update an on-call schedule' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ScheduleView> {
    return this.routing.updateSchedule(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('admin')
  @ApiOperation({ summary: 'Delete an on-call schedule that no policy uses' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.routing.removeSchedule(auth, id);
  }
}

@ApiTags('alerting')
@Controller('silences')
export class SilencesController {
  constructor(private readonly suppression: SuppressionService) {}

  @Get()
  @MinRole('viewer')
  @ApiOperation({ summary: 'Active, upcoming and recently expired silences' })
  list(@CurrentAuth() auth: AuthContext): Promise<SilenceView[]> {
    return this.suppression.listSilences(auth);
  }

  @Post()
  @MinRole('member')
  @ApiOperation({
    summary: 'Mute notifications for a scope for a limited time',
  })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<SilenceView> {
    return this.suppression.createSilence(auth, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('member')
  @ApiOperation({ summary: 'Remove a silence' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.suppression.removeSilence(auth, id);
  }
}

@ApiTags('alerting')
@Controller('maintenance-windows')
export class MaintenanceController {
  constructor(private readonly suppression: SuppressionService) {}

  @Get()
  @MinRole('viewer')
  @Scope('maintenance:read')
  @ApiOperation({ summary: 'Maintenance windows' })
  list(@CurrentAuth() auth: AuthContext): Promise<MaintenanceView[]> {
    return this.suppression.listWindows(auth);
  }

  @Post()
  @MinRole('member')
  @Scope('maintenance:write')
  @ApiOperation({
    summary: 'Create a one-time, daily or weekly maintenance window',
  })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<MaintenanceView> {
    return this.suppression.createWindow(auth, body);
  }

  @Patch(':id')
  @MinRole('member')
  @Scope('maintenance:write')
  @ApiOperation({ summary: 'Update a maintenance window' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<MaintenanceView> {
    return this.suppression.updateWindow(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('member')
  @Scope('maintenance:write')
  @ApiOperation({ summary: 'Delete a maintenance window' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.suppression.removeWindow(auth, id);
  }
}

@ApiTags('incidents')
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @MinRole('viewer')
  @Scope('incidents:read')
  @ApiOperation({ summary: 'Incidents, newest first' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query('status') status?: string,
    @Query('monitorId', new ParseUUIDPipe({ optional: true }))
    monitorId?: string,
    @Query('limit') limit?: string,
    @Query('serverId', new ParseUUIDPipe({ optional: true })) serverId?: string,
  ): Promise<IncidentView[]> {
    return this.incidents.list(auth, { status, monitorId, serverId, limit });
  }

  @Get('summary')
  @MinRole('viewer')
  @Scope('incidents:read')
  @ApiOperation({
    summary: 'Counts and the active incidents for badges and the dashboard',
  })
  summary(@CurrentAuth() auth: AuthContext): Promise<IncidentSummary> {
    return this.incidents.summary(auth);
  }

  @Get(':id')
  @MinRole('viewer')
  @Scope('incidents:read')
  @ApiOperation({ summary: 'One incident with its timeline and notifications' })
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IncidentDetail> {
    return this.incidents.detail(auth, id);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @MinRole('member')
  @Scope('incidents:write')
  @ApiOperation({
    summary: 'Acknowledge an incident and stop further escalation',
  })
  acknowledge(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<IncidentDetail> {
    return this.incidents.acknowledge(auth, id, body);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @MinRole('member')
  @Scope('incidents:write')
  @ApiOperation({ summary: 'Resolve an incident by hand' })
  resolve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<IncidentDetail> {
    return this.incidents.resolve(auth, id, body);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @MinRole('member')
  @ApiOperation({ summary: 'Assign an incident to a member or unassign it' })
  assign(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<IncidentDetail> {
    return this.incidents.assign(auth, id, body);
  }

  @Post(':id/notes')
  @MinRole('member')
  @Scope('incidents:write')
  @ApiOperation({ summary: 'Add a note to the timeline' })
  note(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<IncidentDetail> {
    return this.incidents.addNote(auth, id, body);
  }

  @Put(':id/postmortem')
  @MinRole('member')
  @ApiOperation({ summary: 'Write or replace the postmortem' })
  postmortem(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<IncidentDetail> {
    return this.incidents.setPostmortem(auth, id, body);
  }
}
