import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Db } from '../database/executor';
import type { MemberRef } from './alert.types';

const OWNED_TABLES = {
  channels: 'notification_channels',
  monitors: 'monitors',
  policies: 'escalation_policies',
  schedules: 'oncall_schedules',
  servers: 'servers',
} as const;

export type OwnedKind = keyof typeof OWNED_TABLES;

const LABELS: Record<OwnedKind, string> = {
  channels: 'channel',
  monitors: 'monitor',
  policies: 'escalation policy',
  schedules: 'on-call schedule',
  servers: 'server',
};

export async function assertOwned(
  db: Db,
  kind: OwnedKind,
  orgId: string,
  ids: string[],
): Promise<void> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return;
  const found = await db.rows<{ id: string }>(
    `SELECT id FROM ${OWNED_TABLES[kind]} WHERE org_id = $1 AND id = ANY($2::uuid[])`,
    [orgId, wanted],
  );
  if (found.length !== wanted.length) {
    throw new BadRequestException(
      `One of the selected ${LABELS[kind]}s no longer exists`,
    );
  }
}

export async function loadMembers(
  db: Db,
  orgId: string,
  ids: string[],
): Promise<Map<string, MemberRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db.rows<{ id: string; name: string; email: string }>(
    `SELECT u.id, u.name, u.email
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND u.id = ANY($2::uuid[])`,
    [orgId, [...new Set(ids)]],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, name: row.name, email: row.email },
    ]),
  );
}

export async function assertMembers(
  db: Db,
  orgId: string,
  ids: string[],
): Promise<void> {
  const wanted = [...new Set(ids)];
  const found = await loadMembers(db, orgId, wanted);
  if (found.size !== wanted.length) {
    throw new BadRequestException(
      'Everyone you pick must belong to this workspace',
    );
  }
}

export function notFound(what: string): NotFoundException {
  return new NotFoundException(`${what} not found`);
}

export function inUse(what: string, names: string[]): ConflictException {
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
  return new ConflictException(
    `${what} is still used by ${shown}${more}. Remove it there first.`,
  );
}

export function uuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
