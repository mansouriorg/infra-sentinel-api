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
  Query,
  Req,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole, Public, Scope } from '../auth/decorators';
import { EventBus } from './event-bus';
import type {
  CheckView,
  EventView,
  MonitorDetail,
  MonitorView,
  Overview,
  Series,
} from './monitor.types';
import { MonitorsService } from './monitors.service';

@ApiTags('monitors')
@Controller('monitors')
export class MonitorsController {
  constructor(private readonly monitors: MonitorsService) {}

  @Get()
  @MinRole('viewer')
  @Scope('monitors:read')
  @ApiOperation({ summary: 'All monitors with 24 hour and 30 day uptime' })
  list(@CurrentAuth() auth: AuthContext): Promise<MonitorView[]> {
    return this.monitors.list(auth);
  }

  @Post('test')
  @HttpCode(200)
  @MinRole('member')
  @ApiOperation({ summary: 'Run a check once without saving anything' })
  test(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<CheckView> {
    return this.monitors.test(auth, body);
  }

  @Post()
  @MinRole('member')
  @Scope('monitors:write')
  @ApiOperation({ summary: 'Create a monitor' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<MonitorDetail> {
    return this.monitors.create(auth, body);
  }

  @Get(':id')
  @MinRole('viewer')
  @Scope('monitors:read')
  @ApiOperation({
    summary: 'One monitor with history, recent checks and events',
  })
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MonitorDetail> {
    return this.monitors.detail(auth, id);
  }

  @Get(':id/series')
  @MinRole('viewer')
  @Scope('monitors:read')
  @ApiOperation({
    summary: 'Response time series for a chart (24h, 7d or 30d)',
  })
  series(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('range') range?: string,
  ): Promise<Series> {
    return this.monitors.series(auth, id, range);
  }

  @Patch(':id')
  @MinRole('member')
  @Scope('monitors:write')
  @ApiOperation({
    summary: 'Update a monitor. When config is sent it replaces the old one.',
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<MonitorDetail> {
    return this.monitors.update(auth, id, body);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @MinRole('member')
  @Scope('monitors:write')
  @ApiOperation({ summary: 'Stop checking a monitor' })
  pause(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MonitorDetail> {
    return this.monitors.setPaused(auth, id, true);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @MinRole('member')
  @Scope('monitors:write')
  @ApiOperation({ summary: 'Start checking a paused monitor again' })
  resume(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MonitorDetail> {
    return this.monitors.setPaused(auth, id, false);
  }

  @Post(':id/check')
  @HttpCode(200)
  @MinRole('member')
  @Scope('monitors:write')
  @ApiOperation({ summary: 'Run a check right now and record the result' })
  check(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MonitorDetail> {
    return this.monitors.runNow(auth, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('admin')
  @ApiOperation({ summary: 'Delete a monitor and its history' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.monitors.remove(auth, id);
  }
}

@ApiTags('overview')
@Controller()
export class OverviewController {
  constructor(private readonly monitors: MonitorsService) {}

  @Get('overview')
  @MinRole('viewer')
  @Scope('monitors:read')
  @ApiOperation({
    summary: 'Dashboard numbers: counts, uptime, problems and recent events',
  })
  overview(@CurrentAuth() auth: AuthContext): Promise<Overview> {
    return this.monitors.overview(auth);
  }

  @Get('events')
  @MinRole('viewer')
  @Scope('monitors:read')
  @ApiOperation({ summary: 'Latest status changes across all monitors' })
  events(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<EventView[]> {
    const parsed = Number.parseInt(limit ?? '', 10);
    const bounded = Number.isFinite(parsed)
      ? Math.min(100, Math.max(1, parsed))
      : 30;
    return this.monitors.events(auth, bounded);
  }
}

@ApiTags('heartbeat')
@Public()
@Controller('heartbeat')
export class HeartbeatController {
  constructor(private readonly monitors: MonitorsService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Tell a heartbeat monitor that the job is alive' })
  ping(@Param('token') token: string, @Req() request: Request) {
    return this.monitors.heartbeat(token, request.ip ?? 'unknown', false);
  }

  @Post(':token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Same as GET, for tools that prefer POST' })
  pingPost(@Param('token') token: string, @Req() request: Request) {
    return this.monitors.heartbeat(token, request.ip ?? 'unknown', false);
  }

  @Get(':token/fail')
  @ApiOperation({ summary: 'Tell a heartbeat monitor that the job failed' })
  fail(@Param('token') token: string, @Req() request: Request) {
    return this.monitors.heartbeat(token, request.ip ?? 'unknown', true);
  }

  @Post(':token/fail')
  @HttpCode(200)
  @ApiOperation({ summary: 'Same as GET, for tools that prefer POST' })
  failPost(@Param('token') token: string, @Req() request: Request) {
    return this.monitors.heartbeat(token, request.ip ?? 'unknown', true);
  }
}

const STREAM_MAX_MS = 30 * 60_000;
const STREAM_PING_MS = 25_000;
const STREAMS_PER_ORG = 25;

@ApiTags('stream')
@Controller('stream')
export class StreamController {
  constructor(private readonly bus: EventBus) {}

  @Get()
  @MinRole('viewer')
  @ApiOperation({ summary: 'Live monitor updates as server-sent events' })
  stream(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Res() response: Response,
  ): void {
    if (this.bus.listenerCount(auth.orgId) >= STREAMS_PER_ORG) {
      throw new HttpException(
        'Too many open dashboards for this organization',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    response.write('retry: 3000\n\n');

    const unsubscribe = this.bus.subscribe(auth.orgId, (event) => {
      response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    });
    const ping = setInterval(
      () => response.write(': ping\n\n'),
      STREAM_PING_MS,
    );
    const expire = setTimeout(() => response.end(), STREAM_MAX_MS);
    ping.unref();
    expire.unref();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearTimeout(expire);
      unsubscribe();
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
  }
}
