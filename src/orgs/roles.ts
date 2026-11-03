export const ROLES = ['viewer', 'member', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export function canManage(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true;
  return actor === 'admin' && RANK[target] < RANK.admin;
}

export function canAssign(actor: Role, role: Role): boolean {
  if (actor === 'owner') return true;
  return actor === 'admin' && RANK[role] < RANK.admin;
}
