import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { sha256 } from '../common/crypto';
import type { Role } from '../orgs/roles';

export const API_KEY_PREFIX = 'isk_';
export const MAX_ACTIVE_KEYS = 50;
export const EXPIRY_CHOICES = [30, 90, 180, 365] as const;

export interface ScopeInfo {
  id: string;
  label: string;
  description: string;
  access: 'read' | 'write';
}

export const API_SCOPES = [
  {
    id: 'monitors:read',
    label: 'Read monitors',
    description:
      'List monitors and read their status, history and the overview.',
    access: 'read',
  },
  {
    id: 'monitors:write',
    label: 'Change monitors',
    description:
      'Create and edit monitors, pause and resume them, and run a check now.',
    access: 'write',
  },
  {
    id: 'incidents:read',
    label: 'Read incidents',
    description: 'List incidents and read their details and timeline.',
    access: 'read',
  },
  {
    id: 'incidents:write',
    label: 'Handle incidents',
    description: 'Acknowledge and resolve incidents and add notes.',
    access: 'write',
  },
  {
    id: 'servers:read',
    label: 'Read servers',
    description: 'List servers and read their metrics.',
    access: 'read',
  },
  {
    id: 'maintenance:read',
    label: 'Read maintenance',
    description: 'List maintenance windows.',
    access: 'read',
  },
  {
    id: 'maintenance:write',
    label: 'Change maintenance',
    description:
      'Create, edit and delete maintenance windows, for example around a deploy.',
    access: 'write',
  },
  {
    id: 'status:read',
    label: 'Read status pages',
    description: 'List status pages and read their settings.',
    access: 'read',
  },
  {
    id: 'status:write',
    label: 'Post public updates',
    description: 'Post and remove public updates on incidents.',
    access: 'write',
  },
  {
    id: 'reports:read',
    label: 'Read reports',
    description: 'Download SLA reports as JSON, CSV or PDF.',
    access: 'read',
  },
] as const satisfies readonly ScopeInfo[];

export type ApiScope = (typeof API_SCOPES)[number]['id'];

const SCOPE_IDS = API_SCOPES.map((scope) => scope.id) as readonly string[];
const KEY_PATTERN = /^isk_([0-9a-f]{10})_([A-Za-z0-9_-]{40})$/;

export interface GeneratedKey {
  token: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(): GeneratedKey {
  const id = randomBytes(5).toString('hex');
  const secret = randomBytes(30).toString('base64url');
  const token = `${API_KEY_PREFIX}${id}_${secret}`;
  return { token, prefix: `${API_KEY_PREFIX}${id}`, hash: sha256(token) };
}

export function isApiKeyToken(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

export function parseApiKey(
  token: string,
): { prefix: string; hash: string } | null {
  const match = KEY_PATTERN.exec(token);
  if (!match) return null;
  return { prefix: `${API_KEY_PREFIX}${match[1]}`, hash: sha256(token) };
}

export function expandScopes(input: readonly string[]): ApiScope[] {
  const wanted = new Set<string>(input);
  for (const scope of input) {
    if (scope.endsWith(':write')) wanted.add(scope.replace(/:write$/, ':read'));
  }
  return API_SCOPES.map((scope) => scope.id).filter(
    (id) => wanted.has(id) && SCOPE_IDS.includes(id),
  );
}

export function isKnownScope(value: string): value is ApiScope {
  return SCOPE_IDS.includes(value);
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function effectiveRole(
  scopes: readonly string[],
  creatorRole: Role,
): Role {
  const cap: Role = scopes.some((scope) => scope.endsWith(':write'))
    ? 'member'
    : 'viewer';
  return RANK[creatorRole] < RANK[cap] ? creatorRole : cap;
}

export function expiryDate(
  days: number | null | undefined,
  now: number = Date.now(),
): Date | null {
  return days ? new Date(now + days * 86_400_000) : null;
}

export type KeyStatus = 'active' | 'expired' | 'revoked';

export function keyStatus(
  row: { revoked_at: unknown; expires_at: unknown },
  now: number = Date.now(),
): KeyStatus {
  if (row.revoked_at) return 'revoked';
  if (
    row.expires_at &&
    new Date(row.expires_at as string | number | Date).getTime() <= now
  )
    return 'expired';
  return 'active';
}

export const createKeySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the key a name')
    .max(60, 'The name can have at most 60 characters'),
  scopes: z
    .array(z.string())
    .min(1, 'Choose at least one scope')
    .max(API_SCOPES.length)
    .superRefine((value, context) => {
      const unknown = value.filter((scope) => !isKnownScope(scope));
      if (unknown.length > 0)
        context.addIssue({
          code: 'custom',
          message: `Unknown scope: ${unknown[0]}`,
        });
    }),
  expiresInDays: z
    .number()
    .int()
    .refine(
      (value) => (EXPIRY_CHOICES as readonly number[]).includes(value),
      'Choose 30, 90, 180 or 365 days, or no expiry',
    )
    .nullable()
    .optional(),
});

export type CreateKeyInput = z.infer<typeof createKeySchema>;
