export type ActorType = 'user' | 'api_key' | 'system';

export interface AuditEntry {
  orgId: string;
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string;
  action: string;
  targetType?: string;
  targetId?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditView {
  id: string;
  at: string;
  actor: { type: ActorType; id: string | null; label: string };
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditPage {
  items: AuditView[];
  nextBefore: string | null;
}
