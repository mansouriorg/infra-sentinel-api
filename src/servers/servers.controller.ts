import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole, Public, Scope } from '../auth/decorators';
import { clientMeta } from '../auth/session-cookie';
import {
  AgentService,
  type EnrollResult,
  type ReportResult,
} from './agent.service';
import { ServerRulesService } from './server-rules.service';
import type {
  CreatedEnrollmentToken,
  EnrollmentTokenView,
  MetricSeries,
  ServerDetail,
  ServerRuleView,
  ServerSummary,
} from './server.types';
import { ServersService, type AgentInfoView } from './servers.service';

@ApiTags('servers')
@Controller('servers')
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  @Get()
  @MinRole('viewer')
  @Scope('servers:read')
  @ApiOperation({ summary: 'All servers with their latest numbers' })
  list(@CurrentAuth() auth: AuthContext): Promise<ServerSummary[]> {
    return this.servers.list(auth);
  }

  @Get('agent-info')
  @MinRole('viewer')
  @ApiOperation({
    summary: 'Where the agent downloads from and which builds exist',
  })
  agentInfo(): AgentInfoView {
    return this.servers.agentInfo();
  }

  @Get(':id')
  @MinRole('viewer')
  @Scope('servers:read')
  @ApiOperation({
    summary: 'One server with disks, containers, processes and services',
  })
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ServerDetail> {
    return this.servers.detail(auth, id);
  }

  @Get(':id/metrics')
  @MinRole('viewer')
  @Scope('servers:read')
  @ApiOperation({ summary: 'Metric series for charts (1h, 6h, 24h or 7d)' })
  metrics(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('range') range?: string,
  ): Promise<MetricSeries> {
    return this.servers.metrics(auth, id, range);
  }

  @Patch(':id')
  @MinRole('admin')
  @ApiOperation({ summary: 'Rename a server or change its tags' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ServerDetail> {
    return this.servers.update(auth, id, body);
  }

  @Put(':id/monitors')
  @MinRole('admin')
  @ApiOperation({ summary: 'Link monitors to a server' })
  setMonitors(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ServerDetail> {
    return this.servers.setMonitors(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('admin')
  @ApiOperation({ summary: 'Remove a server and its history' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.servers.remove(auth, id);
  }
}

@ApiTags('servers')
@Controller('enrollment-tokens')
export class EnrollmentTokensController {
  constructor(private readonly servers: ServersService) {}

  @Get()
  @MinRole('admin')
  @ApiOperation({ summary: 'Enrollment tokens' })
  list(@CurrentAuth() auth: AuthContext): Promise<EnrollmentTokenView[]> {
    return this.servers.listTokens(auth);
  }

  @Post()
  @MinRole('admin')
  @ApiOperation({
    summary: 'Create an enrollment token. The secret is shown once.',
  })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<CreatedEnrollmentToken> {
    return this.servers.createToken(auth, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('admin')
  @ApiOperation({ summary: 'Revoke an enrollment token' })
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.servers.revokeToken(auth, id);
  }
}

@ApiTags('servers')
@Controller('server-rules')
export class ServerRulesController {
  constructor(private readonly rules: ServerRulesService) {}

  @Get()
  @MinRole('viewer')
  @ApiOperation({ summary: 'Server alert rules' })
  list(@CurrentAuth() auth: AuthContext): Promise<ServerRuleView[]> {
    return this.rules.list(auth);
  }

  @Post()
  @MinRole('admin')
  @ApiOperation({ summary: 'Create a server alert rule' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<ServerRuleView> {
    return this.rules.create(auth, body);
  }

  @Patch(':id')
  @MinRole('admin')
  @ApiOperation({ summary: 'Update a server alert rule' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ServerRuleView> {
    return this.rules.update(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('admin')
  @ApiOperation({ summary: 'Delete a server alert rule' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.rules.remove(auth, id);
  }
}

@ApiTags('agent')
@Public()
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('enroll')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange an enrollment token for an agent key' })
  enroll(
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<EnrollResult> {
    return this.agent.enroll(body, clientMeta(request));
  }

  @Post('report')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send metrics and a snapshot, authenticated with the agent key',
  })
  report(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ReportResult> {
    return this.agent.report(authorization, body, clientMeta(request).ip);
  }

  @Get('install.sh')
  @Header('Content-Type', 'text/x-shellscript; charset=utf-8')
  @ApiOperation({ summary: 'Install script for Linux and macOS' })
  installScript(): string {
    return this.agent.installScript();
  }

  @Get('download')
  @ApiOperation({ summary: 'Agent binary, for example ?os=linux&arch=amd64' })
  download(
    @Query('os') osName: string | undefined,
    @Query('arch') arch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): StreamableFile {
    const { path, file } = this.agent.binaryPath(
      typeof osName === 'string' ? osName : '',
      typeof arch === 'string' ? arch : '',
    );
    response.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${file}"`,
    });
    return new StreamableFile(createReadStream(path));
  }
}
