import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole, Public } from '../auth/decorators';
import { SessionsService } from '../auth/sessions.service';
import {
  AcceptInviteDto,
  ChangeRoleDto,
  CreateInviteDto,
  CreateOrganizationDto,
  SwitchOrganizationDto,
} from './orgs.dto';
import type { OrgSummary } from './orgs.queries';
import {
  OrgsService,
  type InvitePreview,
  type InviteView,
  type MemberView,
} from './orgs.service';

const SSO_LIMIT =
  'This session is limited to the organization you signed in to with single sign-on';

function refuseSso(auth: AuthContext): void {
  if (auth.ssoOrgId) throw new ForbiddenException(SSO_LIMIT);
}

@ApiTags('organizations')
@Controller('orgs')
export class OrgsController {
  constructor(
    private readonly orgs: OrgsService,
    private readonly sessions: SessionsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Organizations you belong to' })
  async list(@CurrentAuth() auth: AuthContext): Promise<OrgSummary[]> {
    const all = await this.orgs.mine(auth.user.id);
    return auth.ssoOrgId ? all.filter((org) => org.id === auth.ssoOrgId) : all;
  }

  @Post()
  @ApiOperation({ summary: 'Create an organization and switch to it' })
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CreateOrganizationDto,
  ): Promise<OrgSummary> {
    refuseSso(auth);
    const org = await this.orgs.create(auth.user.id, dto.name);
    await this.sessions.setOrganization(auth.sessionId, org.id);
    return org;
  }

  @Post('switch')
  @HttpCode(200)
  @ApiOperation({ summary: 'Make another organization the active one' })
  async activate(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: SwitchOrganizationDto,
  ): Promise<OrgSummary> {
    refuseSso(auth);
    const org = await this.orgs.assertMember(auth.user.id, dto.organizationId);
    await this.sessions.setOrganization(auth.sessionId, org.id);
    return org;
  }

  @Patch('current')
  @MinRole('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Rename the active organization' })
  rename(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CreateOrganizationDto,
  ): Promise<void> {
    return this.orgs.rename(auth.orgId, dto.name);
  }

  @Get('current/members')
  @MinRole('viewer')
  @ApiOperation({ summary: 'People in the active organization' })
  members(@CurrentAuth() auth: AuthContext): Promise<MemberView[]> {
    return this.orgs.members(auth.orgId);
  }

  @Patch('current/members/:userId')
  @MinRole('admin')
  @HttpCode(204)
  @ApiOperation({ summary: "Change someone's role" })
  changeRole(
    @CurrentAuth() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ChangeRoleDto,
  ): Promise<void> {
    return this.orgs.changeRole(auth, userId, dto.role);
  }

  @Delete('current/members/:userId')
  @MinRole('viewer')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove someone, or leave the organization yourself',
  })
  removeMember(
    @CurrentAuth() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.orgs.removeMember(auth, userId);
  }

  @Get('current/invites')
  @MinRole('admin')
  @ApiOperation({ summary: 'Pending invitations' })
  invites(@CurrentAuth() auth: AuthContext): Promise<InviteView[]> {
    return this.orgs.invites(auth.orgId);
  }

  @Post('current/invites')
  @MinRole('admin')
  @ApiOperation({ summary: 'Invite someone by email' })
  invite(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CreateInviteDto,
  ): Promise<{ invite: InviteView; emailSent: boolean; link: string }> {
    return this.orgs.invite(auth, dto.email, dto.role);
  }

  @Delete('current/invites/:inviteId')
  @MinRole('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel a pending invitation' })
  revokeInvite(
    @CurrentAuth() auth: AuthContext,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ): Promise<void> {
    return this.orgs.revokeInvite(auth.orgId, inviteId);
  }
}

@ApiTags('organizations')
@Controller('invites')
export class InvitesController {
  constructor(
    private readonly orgs: OrgsService,
    private readonly sessions: SessionsService,
  ) {}

  @Public()
  @Get(':token')
  @ApiOperation({ summary: 'Look at an invitation before accepting it' })
  preview(@Param('token') token: string): Promise<InvitePreview> {
    return this.orgs.preview(token);
  }

  @Post('accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation and switch to that organization',
  })
  async accept(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: AcceptInviteDto,
  ): Promise<OrgSummary> {
    refuseSso(auth);
    const org = await this.orgs.accept(auth, dto.token);
    await this.sessions.setOrganization(auth.sessionId, org.id);
    return org;
  }
}
