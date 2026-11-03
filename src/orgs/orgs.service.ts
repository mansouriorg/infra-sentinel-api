import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { normalizeEmail, randomToken, sha256 } from '../common/crypto';
import { RateLimiter } from '../common/rate-limiter';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import type { AuthContext } from '../auth/auth.types';
import { MailService } from '../mail/mail.service';
import {
  createOrganization,
  listOrganizations,
  type OrgSummary,
} from './orgs.queries';
import { canAssign, canManage, type Role } from './roles';

export interface MemberView {
  id: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: Date;
  twoFactor: boolean;
  sharedElsewhere: boolean;
}

export interface InviteView {
  id: string;
  email: string;
  role: Role;
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface InvitePreview {
  email: string;
  role: Role;
  organization: string;
  invitedBy: string | null;
}

const INVITE_TTL_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;
const INVITES_PER_PERSON = 20;
const INVITES_PER_ORG = 60;
const MAX_OWNED_ORGS = 10;

@Injectable()
export class OrgsService {
  private readonly limiter = new RateLimiter();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly mail: MailService,
  ) {}

  mine(userId: string): Promise<OrgSummary[]> {
    return listOrganizations(this.db, userId);
  }

  async create(userId: string, name: string): Promise<OrgSummary> {
    const owned = await this.db.row<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND role = 'owner'`,
      [userId],
    );
    if ((owned?.n ?? 0) >= MAX_OWNED_ORGS) {
      throw new BadRequestException(
        `You can own up to ${MAX_OWNED_ORGS} workspaces`,
      );
    }
    return this.db.tx((tx) => createOrganization(tx, userId, name.trim()));
  }

  async assertMember(userId: string, orgId: string): Promise<OrgSummary> {
    const orgs = await listOrganizations(this.db, userId);
    const found = orgs.find((org) => org.id === orgId);
    if (!found) throw new NotFoundException('Organization not found');
    return found;
  }

  async rename(orgId: string, name: string): Promise<void> {
    await this.db.run('UPDATE organizations SET name = $1 WHERE id = $2', [
      name.trim(),
      orgId,
    ]);
  }

  members(orgId: string): Promise<MemberView[]> {
    return this.db.rows<MemberView>(
      `SELECT u.id, u.name, u.email, m.role, m.created_at AS "joinedAt",
              EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL) AS "twoFactor",
              EXISTS (
                SELECT 1 FROM memberships o
                 WHERE o.user_id = u.id AND o.org_id <> m.org_id
                   AND EXISTS (SELECT 1 FROM memberships x WHERE x.org_id = o.org_id AND x.user_id <> u.id)
              ) AS "sharedElsewhere"
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
                 lower(u.name)`,
      [orgId],
    );
  }

  async changeRole(
    actor: AuthContext,
    targetId: string,
    role: Role,
  ): Promise<void> {
    await this.db.tx(async (tx) => {
      const members = await tx.rows<{ user_id: string; role: Role }>(
        'SELECT user_id, role FROM memberships WHERE org_id = $1 FOR UPDATE',
        [actor.orgId],
      );
      const target = members.find((member) => member.user_id === targetId);
      if (!target)
        throw new NotFoundException('That person is not in this organization');
      if (!canManage(actor.role, target.role) || !canAssign(actor.role, role)) {
        throw new ForbiddenException('You cannot give or change that role');
      }
      const owners = members.filter((member) => member.role === 'owner').length;
      if (target.role === 'owner' && role !== 'owner' && owners <= 1) {
        throw new BadRequestException(
          'An organization needs at least one owner',
        );
      }
      await tx.run(
        'UPDATE memberships SET role = $1 WHERE org_id = $2 AND user_id = $3',
        [role, actor.orgId, targetId],
      );
    });
  }

  async removeMember(actor: AuthContext, targetId: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const members = await tx.rows<{ user_id: string; role: Role }>(
        'SELECT user_id, role FROM memberships WHERE org_id = $1 FOR UPDATE',
        [actor.orgId],
      );
      const target = members.find((member) => member.user_id === targetId);
      if (!target)
        throw new NotFoundException('That person is not in this organization');
      if (targetId !== actor.user.id && !canManage(actor.role, target.role)) {
        throw new ForbiddenException('You cannot remove that person');
      }
      const owners = members.filter((member) => member.role === 'owner').length;
      if (target.role === 'owner' && owners <= 1) {
        throw new BadRequestException(
          'An organization needs at least one owner',
        );
      }
      await tx.run(
        'DELETE FROM memberships WHERE org_id = $1 AND user_id = $2',
        [actor.orgId, targetId],
      );
      await tx.run(
        'UPDATE sessions SET org_id = NULL WHERE org_id = $1 AND user_id = $2',
        [actor.orgId, targetId],
      );
    });
  }

  invites(orgId: string): Promise<InviteView[]> {
    return this.db.rows<InviteView>(
      `SELECT i.id, i.email, i.role, u.name AS "invitedBy",
              i.created_at AS "createdAt", i.expires_at AS "expiresAt"
         FROM invitations i
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now()
        ORDER BY i.created_at DESC`,
      [orgId],
    );
  }

  async invite(
    actor: AuthContext,
    emailInput: string,
    role: Role,
  ): Promise<{ invite: InviteView; emailSent: boolean; link: string }> {
    if (!canAssign(actor.role, role)) {
      throw new ForbiddenException('You cannot invite people with that role');
    }
    if (
      !this.limiter.attempt(
        `invite-person:${actor.user.id}`,
        INVITES_PER_PERSON,
        HOUR_MS,
      ) ||
      !this.limiter.attempt(
        `invite-org:${actor.orgId}`,
        INVITES_PER_ORG,
        HOUR_MS,
      )
    ) {
      throw new HttpException(
        'You sent a lot of invitations. Please wait a while and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const email = normalizeEmail(emailInput);
    const existing = await this.db.row(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND u.email = $2`,
      [actor.orgId, email],
    );
    if (existing)
      throw new ConflictException(
        'That person is already in this organization',
      );

    const token = randomToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const invite = await this.db.tx(async (tx) => {
      await tx.run(
        'DELETE FROM invitations WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL',
        [actor.orgId, email],
      );
      const row = await tx.row<InviteView>(
        `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, role, created_at AS "createdAt", expires_at AS "expiresAt"`,
        [actor.orgId, email, role, sha256(token), actor.user.id, expiresAt],
      );
      if (!row) throw new Error('Invitation was not created');
      return { ...row, invitedBy: actor.user.name };
    });

    const organization = await this.db.row<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [actor.orgId],
    );
    const url = `${this.config.get('WEB_URL').replace(/\/+$/, '')}/invite/${token}`;
    const emailSent = await this.mail.sendInvitation(
      email,
      actor.user.name,
      organization?.name ?? 'your team',
      role,
      url,
    );
    return { invite, emailSent, link: url };
  }

  async revokeInvite(orgId: string, inviteId: string): Promise<void> {
    const removed = await this.db.run(
      'DELETE FROM invitations WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL',
      [inviteId, orgId],
    );
    if (removed === 0) throw new NotFoundException('Invitation not found');
  }

  async preview(token: string): Promise<InvitePreview> {
    const row = await this.db.row<InvitePreview>(
      `SELECT i.email, i.role, o.name AS organization, u.name AS "invitedBy"
         FROM invitations i
         JOIN organizations o ON o.id = i.org_id
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`,
      [sha256(token)],
    );
    if (!row)
      throw new NotFoundException('This invitation is invalid or has expired');
    return row;
  }

  async accept(actor: AuthContext, token: string): Promise<OrgSummary> {
    const orgId = await this.db.tx(async (tx) => {
      const invite = await tx.row<{
        org_id: string;
        role: Role;
        email: string;
      }>(
        `UPDATE invitations SET accepted_at = now()
          WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
          RETURNING org_id, role, email`,
        [sha256(token)],
      );
      if (!invite)
        throw new NotFoundException(
          'This invitation is invalid or has expired',
        );
      if (invite.email !== actor.user.email) {
        throw new ForbiddenException(
          `This invitation was sent to ${invite.email}. Sign in with that address to accept it.`,
        );
      }
      await tx.run(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [invite.org_id, actor.user.id, invite.role],
      );
      return invite.org_id;
    });
    return this.assertMember(actor.user.id, orgId);
  }
}
