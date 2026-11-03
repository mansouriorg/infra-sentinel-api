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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole, Scope } from '../auth/decorators';
import { PagesService } from './pages.service';
import { UpdatesService } from './updates.service';
import type {
  IncidentStatusView,
  StatusPageDetail,
  StatusPageView,
  SubscriberView,
} from './status.types';

@ApiTags('status-pages')
@Controller('status-pages')
export class StatusPagesController {
  constructor(private readonly pages: PagesService) {}

  @Get()
  @MinRole('viewer')
  @Scope('status:read')
  @ApiOperation({ summary: 'List status pages' })
  list(@CurrentAuth() auth: AuthContext): Promise<StatusPageView[]> {
    return this.pages.list(auth);
  }

  @Post()
  @MinRole('admin')
  @ApiOperation({ summary: 'Create a status page' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<StatusPageDetail> {
    return this.pages.create(auth, body);
  }

  @Get(':id')
  @MinRole('viewer')
  @Scope('status:read')
  @ApiOperation({ summary: 'One status page with its components' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StatusPageDetail> {
    return this.pages.get(auth, id);
  }

  @Patch(':id')
  @MinRole('admin')
  @ApiOperation({
    summary: 'Change the appearance, address or visibility of a status page',
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<StatusPageDetail> {
    return this.pages.update(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @MinRole('admin')
  @ApiOperation({ summary: 'Delete a status page' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.pages.remove(auth, id);
  }

  @Put(':id/components')
  @MinRole('admin')
  @ApiOperation({ summary: 'Replace the components shown on a status page' })
  components(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<StatusPageDetail> {
    return this.pages.setComponents(auth, id, body);
  }

  @Put(':id/domain')
  @MinRole('admin')
  @ApiOperation({ summary: 'Set or clear the custom domain' })
  domain(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<StatusPageDetail> {
    return this.pages.setDomain(auth, id, body);
  }

  @Post(':id/domain/verify')
  @HttpCode(200)
  @MinRole('admin')
  @ApiOperation({
    summary: 'Check the DNS record and verify the custom domain',
  })
  verify(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StatusPageDetail> {
    return this.pages.verifyDomain(auth, id);
  }

  @Get(':id/subscribers')
  @MinRole('admin')
  @ApiOperation({ summary: 'Email subscribers of a status page' })
  subscribers(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SubscriberView[]> {
    return this.pages.subscribers(auth, id);
  }

  @Delete(':id/subscribers/:subscriberId')
  @HttpCode(204)
  @MinRole('admin')
  @ApiOperation({ summary: 'Remove a subscriber' })
  removeSubscriber(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('subscriberId', new ParseUUIDPipe()) subscriberId: string,
  ): Promise<void> {
    return this.pages.removeSubscriber(auth, id, subscriberId);
  }
}

@ApiTags('status-pages')
@Controller('incidents')
export class IncidentStatusController {
  constructor(private readonly updates: UpdatesService) {}

  @Get(':id/status')
  @MinRole('viewer')
  @Scope('status:read')
  @ApiOperation({
    summary:
      'What this incident looks like on status pages, with its public updates',
  })
  view(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<IncidentStatusView> {
    return this.updates.view(auth, id);
  }

  @Patch(':id/status')
  @MinRole('member')
  @Scope('status:write')
  @ApiOperation({
    summary: 'Set a public title or hide the incident from status pages',
  })
  patch(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<IncidentStatusView> {
    return this.updates.patch(auth, id, body);
  }

  @Post(':id/status-updates')
  @MinRole('member')
  @Scope('status:write')
  @ApiOperation({ summary: 'Post a public update on status pages' })
  post(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<IncidentStatusView> {
    return this.updates.post(auth, id, body);
  }

  @Delete(':id/status-updates/:updateId')
  @MinRole('member')
  @Scope('status:write')
  @ApiOperation({ summary: 'Delete a public update' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('updateId', new ParseUUIDPipe()) updateId: string,
  ): Promise<IncidentStatusView> {
    return this.updates.removeUpdate(auth, id, updateId);
  }
}
