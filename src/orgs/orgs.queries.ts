import { slugify } from '../common/crypto';
import type { Db } from '../database/executor';
import type { Role } from './roles';

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export async function createOrganization(
  db: Db,
  userId: string,
  name: string,
): Promise<OrgSummary> {
  const org = await db.row<{ id: string; name: string; slug: string }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug`,
    [name, slugify(name)],
  );
  if (!org) throw new Error('Organization was not created');
  await db.run(
    `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [org.id, userId],
  );
  return { ...org, role: 'owner' };
}

export function listOrganizations(
  db: Db,
  userId: string,
): Promise<OrgSummary[]> {
  return db.rows<OrgSummary>(
    `SELECT o.id, o.name, o.slug, m.role
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1
      ORDER BY m.created_at, o.name`,
    [userId],
  );
}
