import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { toIso } from '../common/time';
import { DatabaseService } from '../database/database.service';
import { parseWith } from '../monitors/monitor.schema';
import type { Role } from '../orgs/roles';
import {
  MAX_ACTIVE_KEYS,
  createKeySchema,
  effectiveRole,
  expandScopes,
  expiryDate,
  generateApiKey,
  keyStatus,
  parseApiKey,
  type KeyStatus,
} from './api-keys';
import type { AuthContext } from './auth.types';

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: KeyStatus;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey {
  key: ApiKeyView;
  token: string;
}

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: Date | string;
  expires_at: Date | string | null;
  last_used_at: Date | string | null;
  last_used_ip: string | null;
  revoked_at: Date | string | null;
  creator_id: string | null;
  creator_name: string | null;
}

interface AuthRow {
  id: string;
  org_id: string;
  name: string;
  scopes: string[];
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  user_id: string;
  email: string;
  user_name: string;
  email_verified_at: Date | string | null;
  role: Role;
}

const optionalIso = (value: Date | string | null): string | null =>
  value ? toIso(value) : null;

function toView(row: KeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    status: keyStatus(row),
    createdAt: toIso(row.created_at),
    createdBy: row.creator_id
      ? { id: row.creator_id, name: row.creator_name ?? '' }
      : null,
    expiresAt: optionalIso(row.expires_at),
    lastUsedAt: optionalIso(row.last_used_at),
    lastUsedIp: row.last_used_ip,
    revokedAt: optionalIso(row.revoked_at),
  };
}

const SELECT_KEYS = `
  SELECT k.id, k.name, k.prefix, k.scopes, k.created_at, k.expires_at, k.last_used_at, k.last_used_ip,
         k.revoked_at, u.id AS creator_id, u.name AS creator_name
    FROM api_keys k
    JOIN users u ON u.id = k.created_by`;

@Injectable()
export class ApiKeysService {
  constructor(private readonly db: DatabaseService) {}

  async list(auth: AuthContext): Promise<ApiKeyView[]> {
    const rows = await this.db.rows<KeyRow>(
      `${SELECT_KEYS} WHERE k.org_id = $1 ORDER BY k.created_at DESC`,
      [auth.orgId],
    );
    return rows.map(toView);
  }

  async create(auth: AuthContext, body: unknown): Promise<CreatedApiKey> {
    const input = parseWith(createKeySchema, body);
    const scopes = expandScopes(input.scopes);
    const generated = generateApiKey();
    const expiresAt = expiryDate(input.expiresInDays);

    const id = await this.db.tx(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `api-keys:${auth.orgId}`,
      ]);
      const active = await tx.row<{ count: string }>(
        `SELECT count(*) AS count FROM api_keys
          WHERE org_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
        [auth.orgId],
      );
      if (Number(active?.count ?? 0) >= MAX_ACTIVE_KEYS) {
        throw new BadRequestException(
          `This workspace already has ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`,
        );
      }
      const row = await tx.row<{ id: string }>(
        `INSERT INTO api_keys (org_id, created_by, name, prefix, key_hash, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7) RETURNING id`,
        [
          auth.orgId,
          auth.user.id,
          input.name,
          generated.prefix,
          generated.hash,
          scopes,
          expiresAt,
        ],
      );
      if (!row) throw new Error('API key was not created');
      return row.id;
    });

    const row = await this.db.row<KeyRow>(`${SELECT_KEYS} WHERE k.id = $1`, [
      id,
    ]);
    if (!row) throw new NotFoundException('API key not found');
    return { key: toView(row), token: generated.token };
  }

  async revoke(auth: AuthContext, id: string): Promise<ApiKeyView> {
    const count = await this.db.run(
      'UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
    if (count === 0) throw new NotFoundException('API key not found');
    const row = await this.db.row<KeyRow>(`${SELECT_KEYS} WHERE k.id = $1`, [
      id,
    ]);
    if (!row) throw new NotFoundException('API key not found');
    return toView(row);
  }

  async authenticate(token: string, ip: string): Promise<AuthContext | null> {
    const parsed = parseApiKey(token);
    if (!parsed) return null;
    const row = await this.db.row<AuthRow>(
      `SELECT k.id, k.org_id, k.name, k.scopes, k.expires_at, k.revoked_at,
              u.id AS user_id, u.email, u.name AS user_name, u.email_verified_at, m.role
         FROM api_keys k
         JOIN users u ON u.id = k.created_by
         JOIN memberships m ON m.org_id = k.org_id AND m.user_id = k.created_by
        WHERE k.key_hash = $1`,
      [parsed.hash],
    );
    if (!row || keyStatus(row) !== 'active') return null;

    await this.db.run(
      `UPDATE api_keys SET last_used_at = now(), last_used_ip = $2
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [row.id, ip.slice(0, 64)],
    );

    return {
      sessionId: '',
      user: {
        id: row.user_id,
        email: row.email,
        name: row.user_name,
        emailVerified: row.email_verified_at !== null,
      },
      orgId: row.org_id,
      role: effectiveRole(row.scopes, row.role),
      apiKey: { id: row.id, name: row.name, scopes: row.scopes },
    };
  }
}
