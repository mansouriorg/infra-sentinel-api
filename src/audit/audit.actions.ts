import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import type { ActorType } from './audit.types';

const SKIPPED = new Set([
  'monitors.test',
  'orgs.activate',
  'sso.test',
  'notifications.read',
  'preferences.update',
]);
const ORG_FROM_RESULT = new Set(['orgs.create', 'invites.accept']);
const LABEL_KEYS = ['name', 'title', 'label', 'email', 'slug'];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function controllerSegment(path: unknown): string {
  const raw = Array.isArray(path) ? path[0] : path;
  const text = typeof raw === 'string' ? raw : '';
  return (
    text.split('/').find((part) => part !== '' && !part.startsWith(':')) ??
    'api'
  );
}

export function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function deriveAction(controllerPath: unknown, handler: string): string {
  return `${controllerSegment(controllerPath)}.${snakeCase(handler)}`;
}

export function isAuditable(method: string, action: string): boolean {
  return (
    method !== 'GET' &&
    method !== 'HEAD' &&
    method !== 'OPTIONS' &&
    !SKIPPED.has(action)
  );
}

export function takesOrgFromResult(action: string): boolean {
  return ORG_FROM_RESULT.has(action);
}

export function bodyFields(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return [];
  return Object.keys(body).sort().slice(0, 30);
}

export function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function labelIn(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Record<string, unknown>;
  for (const key of LABEL_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim() !== '')
      return candidate;
  }
  return '';
}

export function pickSummary(result: unknown, body: unknown): string {
  const direct = labelIn(result);
  if (direct) return clip(direct, 120);
  if (typeof result === 'object' && result !== null) {
    for (const nested of Object.values(result)) {
      if (
        typeof nested === 'object' &&
        nested !== null &&
        !Array.isArray(nested)
      ) {
        const found = labelIn(nested);
        if (found) return clip(found, 120);
      }
    }
  }
  return clip(labelIn(body), 120);
}

export function pickTarget(
  params: Record<string, unknown> | undefined,
  result: unknown,
): string {
  for (const value of Object.values(params ?? {})) {
    if (typeof value === 'string' && UUID.test(value)) return value;
  }
  const id =
    typeof result === 'object' && result !== null
      ? (result as { id?: unknown }).id
      : undefined;
  return typeof id === 'string' && UUID.test(id) ? id : '';
}

export function actorOf(auth: AuthContext): {
  actorType: ActorType;
  actorId: string;
  actorLabel: string;
} {
  if (auth.apiKey)
    return {
      actorType: 'api_key',
      actorId: auth.apiKey.id,
      actorLabel: auth.apiKey.name,
    };
  return {
    actorType: 'user',
    actorId: auth.user.id,
    actorLabel: auth.user.email,
  };
}

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-09-30')
  .refine(
    (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
    'Use a real date',
  );

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || undefined);

export const auditQuerySchema = z.object({
  action: text(80),
  actor: text(120),
  target: text(80),
  from: day.optional().or(z.literal('').transform(() => undefined)),
  to: day.optional().or(z.literal('').transform(() => undefined)),
  before: z
    .string()
    .regex(/^\d{1,18}$/, 'Invalid page marker')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  format: z.enum(['json', 'csv']).default('json'),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const CSV_LIMIT = 10_000;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function buildAuditQuery(
  orgId: string,
  query: AuditQuery,
): { text: string; values: unknown[] } {
  const values: unknown[] = [orgId];
  const where: string[] = ['org_id = $1'];
  const add = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (query.action)
    where.push(
      `action LIKE ${add(`${escapeLike(query.action)}%`)} ESCAPE '\\'`,
    );
  if (query.actor) {
    where.push(
      UUID.test(query.actor)
        ? `actor_id = ${add(query.actor)}::uuid`
        : `actor_label ILIKE ${add(`%${escapeLike(query.actor)}%`)} ESCAPE '\\'`,
    );
  }
  if (query.target) where.push(`target_id = ${add(query.target)}`);
  if (query.from)
    where.push(`created_at >= ${add(`${query.from}T00:00:00Z`)}::timestamptz`);
  if (query.to)
    where.push(
      `created_at < ${add(`${query.to}T00:00:00Z`)}::timestamptz + interval '1 day'`,
    );
  if (query.before) where.push(`id < ${add(query.before)}::bigint`);

  const limit = query.format === 'csv' ? CSV_LIMIT : query.limit;
  return {
    text: `SELECT id, org_id, actor_type, actor_id, actor_label, action, target_type, target_id, summary,
                  metadata, ip, user_agent, created_at
             FROM audit_events
            WHERE ${where.join(' AND ')}
            ORDER BY id DESC
            LIMIT ${add(limit + 1)}`,
    values,
  };
}
