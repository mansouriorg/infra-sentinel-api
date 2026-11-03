import { Injectable } from '@nestjs/common';
import { randomToken, sha256 } from '../common/crypto';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import {
  createOrganization,
  listOrganizations,
  type OrgSummary,
} from '../orgs/orgs.queries';
import type { Role } from '../orgs/roles';
import type { AuthContext, ClientMeta } from './auth.types';

interface SessionRow {
  session_id: string;
  org_id: string | null;
  user_id: string;
  email: string;
  name: string;
  email_verified_at: Date | null;
  role: Role | null;
  sso_org_id: string | null;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
  ) {}

  async create(
    userId: string,
    orgId: string | null,
    meta: ClientMeta,
    ssoOrgId: string | null = null,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const days = this.config.get('SESSION_TTL_DAYS');
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    await this.db.run(
      `INSERT INTO sessions (user_id, org_id, token_hash, user_agent, ip, expires_at, sso_org_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        orgId,
        sha256(token),
        meta.userAgent ?? null,
        meta.ip,
        expiresAt,
        ssoOrgId,
      ],
    );
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<AuthContext | null> {
    const row = await this.db.row<SessionRow>(
      `SELECT s.id AS session_id, s.org_id, u.id AS user_id, u.email, u.name,
              u.email_verified_at, m.role, s.sso_org_id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN memberships m ON m.org_id = s.org_id AND m.user_id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (!row) return null;
    if (row.sso_org_id && (row.org_id !== row.sso_org_id || !row.role))
      return null;

    let orgId = row.org_id;
    let role = row.role;
    if (!orgId || !role) {
      const fallback = await this.fallbackOrganization(row.user_id, row.name);
      await this.db.run('UPDATE sessions SET org_id = $1 WHERE id = $2', [
        fallback.id,
        row.session_id,
      ]);
      orgId = fallback.id;
      role = fallback.role;
    }

    await this.db.run(
      `UPDATE sessions SET last_used_at = now()
        WHERE id = $1 AND last_used_at < now() - interval '1 minute'`,
      [row.session_id],
    );

    return {
      sessionId: row.session_id,
      user: {
        id: row.user_id,
        email: row.email,
        name: row.name,
        emailVerified: row.email_verified_at !== null,
      },
      orgId,
      role,
      ...(row.sso_org_id ? { ssoOrgId: row.sso_org_id } : {}),
    };
  }

  async setOrganization(sessionId: string, orgId: string): Promise<void> {
    await this.db.run('UPDATE sessions SET org_id = $1 WHERE id = $2', [
      orgId,
      sessionId,
    ]);
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE id = $1', [sessionId]);
  }

  async revokeByToken(token: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE token_hash = $1', [
      sha256(token),
    ]);
  }

  async revokeOthers(userId: string, keepSessionId: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [
      userId,
      keepSessionId,
    ]);
  }

  async purgeExpired(): Promise<number> {
    return this.db.run('DELETE FROM sessions WHERE expires_at < now()');
  }

  private fallbackOrganization(
    userId: string,
    name: string,
  ): Promise<OrgSummary> {
    return this.db.tx(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
      const existing = await listOrganizations(tx, userId);
      if (existing.length > 0) return existing[0];
      return createOrganization(tx, userId, `${name}'s workspace`);
    });
  }
}
