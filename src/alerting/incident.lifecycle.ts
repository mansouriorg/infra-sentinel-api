import type { Db } from '../database/executor';
import type { IncidentEventKind, IncidentRow } from './alert.types';

export type Resolution =
  | 'recovered'
  | 'manual'
  | 'monitor_removed'
  | 'monitor_paused'
  | 'server_removed'
  | 'rule_removed';

export async function addIncidentEvent(
  db: Db,
  incidentId: string,
  orgId: string,
  kind: IncidentEventKind,
  message: string,
  actorId: string | null = null,
): Promise<void> {
  await db.run(
    `INSERT INTO incident_events (incident_id, org_id, kind, actor_id, message) VALUES ($1, $2, $3, $4::uuid, $5)`,
    [incidentId, orgId, kind, actorId, message.slice(0, 2000)],
  );
}

export function skipPendingJobs(
  db: Db,
  incidentId: string,
  reason: string,
): Promise<number> {
  return db.run(
    `UPDATE notification_jobs
        SET status = 'skipped', last_error = $2, finished_at = now()
      WHERE incident_id = $1 AND status = 'pending' AND kind IN ('alert', 'escalation')`,
    [incidentId, reason],
  );
}

const RECOVERY_JOBS = `
  INSERT INTO notification_jobs (org_id, incident_id, rule_id, server_rule_id, kind, step, channel_id, schedule_id, target_label, run_at)
  SELECT j.org_id, j.incident_id, j.rule_id, j.server_rule_id, 'recovery', 0, j.channel_id, j.schedule_id, j.target_label, now()
    FROM notification_jobs j
    LEFT JOIN alert_rules r ON r.id = j.rule_id
    LEFT JOIN server_rules sr ON sr.id = j.server_rule_id
   WHERE j.incident_id = $1
     AND j.status = 'sent'
     AND j.kind IN ('alert', 'escalation')
     AND (j.channel_id IS NOT NULL OR j.schedule_id IS NOT NULL)
     AND COALESCE(r.notify_recovery, sr.notify_recovery, true)
  ON CONFLICT DO NOTHING`;

export interface CloseInput {
  resolvedAt: Date | null;
  by: string | null;
  resolution: Resolution;
  message: string;
}

export async function closeIncident(
  db: Db,
  incidentId: string,
  input: CloseInput,
): Promise<IncidentRow | null> {
  const closed = await db.row<IncidentRow>(
    `UPDATE incidents
        SET status = 'resolved',
            resolved_at = GREATEST(started_at, COALESCE($2::timestamptz, now())),
            resolved_by = $3::uuid,
            resolution = $4,
            updated_at = now()
      WHERE id = $1 AND status <> 'resolved'
      RETURNING *`,
    [incidentId, input.resolvedAt, input.by, input.resolution],
  );
  if (!closed) return null;
  await skipPendingJobs(
    db,
    incidentId,
    'The incident was resolved before this was due',
  );
  await db.run(RECOVERY_JOBS, [incidentId]);
  await addIncidentEvent(
    db,
    incidentId,
    closed.org_id,
    'resolved',
    input.message,
    input.by,
  );
  return closed;
}
