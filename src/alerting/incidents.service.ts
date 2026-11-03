import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { EventBus } from '../monitors/event-bus';
import { iso, isoOrNull, num } from '../monitors/monitor.format';
import {
  INCIDENT_SELECT,
  memberRef,
  toIncidentView,
  type IncidentJoinRow,
} from './alert.format';
import { assertMembers, loadMembers, notFound } from './alert.helpers';
import {
  assignSchema,
  closeSchema,
  noteSchema,
  parseWith,
  postmortemSchema,
} from './alert.schema';
import type {
  IncidentDetail,
  IncidentEventKind,
  IncidentEventView,
  IncidentSummary,
  IncidentView,
  NotificationView,
} from './alert.types';
import {
  addIncidentEvent,
  closeIncident,
  skipPendingJobs,
} from './incident.lifecycle';

const STATUS_FILTERS = ['active', 'open', 'acknowledged', 'resolved', 'all'];

interface EventRow {
  id: string;
  at: Date;
  kind: IncidentEventKind;
  message: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
}

interface JobRow {
  id: string;
  kind: NotificationView['kind'];
  step: number;
  target_label: string;
  status: NotificationView['status'];
  attempts: number;
  run_at: Date;
  finished_at: Date | null;
  last_error: string | null;
}

@Injectable()
export class IncidentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly bus: EventBus,
  ) {}

  async list(
    auth: AuthContext,
    query: {
      status?: string;
      monitorId?: string;
      serverId?: string;
      limit?: string;
    },
  ): Promise<IncidentView[]> {
    const status = query.status ?? 'all';
    if (!STATUS_FILTERS.includes(status)) {
      throw new BadRequestException(
        `status must be one of ${STATUS_FILTERS.join(', ')}`,
      );
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const rows = await this.db.rows<IncidentJoinRow>(
      `${INCIDENT_SELECT}
        WHERE i.org_id = $1
          AND ($2::text = 'all'
               OR ($2::text = 'active' AND i.status <> 'resolved')
               OR i.status = $2::text)
          AND ($3::uuid IS NULL OR i.monitor_id = $3::uuid)
          AND ($5::uuid IS NULL OR i.server_id = $5::uuid)
        ORDER BY i.started_at DESC
        LIMIT $4::int`,
      [
        auth.orgId,
        status,
        query.monitorId ?? null,
        limit,
        query.serverId ?? null,
      ],
    );
    return rows.map(toIncidentView);
  }

  async summary(auth: AuthContext): Promise<IncidentSummary> {
    const [counts, active] = await Promise.all([
      this.db.row<{ open: number; acknowledged: number; resolved24h: number }>(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
                count(*) FILTER (WHERE status = 'resolved' AND resolved_at > now() - interval '24 hours')::int AS "resolved24h"
           FROM incidents WHERE org_id = $1`,
        [auth.orgId],
      ),
      this.db.rows<IncidentJoinRow>(
        `${INCIDENT_SELECT}
          WHERE i.org_id = $1 AND i.status <> 'resolved'
          ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, i.started_at
          LIMIT 5`,
        [auth.orgId],
      ),
    ]);
    return {
      open: num(counts?.open) ?? 0,
      acknowledged: num(counts?.acknowledged) ?? 0,
      resolved24h: num(counts?.resolved24h) ?? 0,
      active: active.map(toIncidentView),
    };
  }

  async detail(auth: AuthContext, id: string): Promise<IncidentDetail> {
    const row = await this.requireJoined(auth.orgId, id);
    const [events, jobs] = await Promise.all([
      this.db.rows<EventRow>(
        `SELECT e.id::text AS id, e.at, e.kind, e.message, e.actor_id, u.name AS actor_name, u.email AS actor_email
           FROM incident_events e LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.incident_id = $1 ORDER BY e.at, e.id`,
        [id],
      ),
      this.db.rows<JobRow>(
        `SELECT id::text AS id, kind, step, target_label, status, attempts, run_at, finished_at, last_error
           FROM notification_jobs WHERE incident_id = $1 ORDER BY run_at, id`,
        [id],
      ),
    ]);
    const view = toIncidentView(row);
    return {
      ...view,
      postmortem: row.postmortem,
      postmortemUpdatedAt: isoOrNull(row.postmortem_updated_at),
      events: events.map(
        (event): IncidentEventView => ({
          id: event.id,
          at: iso(event.at),
          kind: event.kind,
          actor: memberRef(event.actor_id, event.actor_name, event.actor_email),
          message: event.message,
        }),
      ),
      notifications: jobs.map(
        (job): NotificationView => ({
          id: job.id,
          kind: job.kind,
          step: job.step,
          target: job.target_label,
          status: job.status,
          attempts: job.attempts,
          runAt: iso(job.run_at),
          finishedAt: isoOrNull(job.finished_at),
          error: job.last_error,
        }),
      ),
    };
  }

  async acknowledge(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<IncidentDetail> {
    const input = parseWith(closeSchema, body);
    const row = await this.requireJoined(auth.orgId, id);
    if (row.status === 'resolved')
      throw new ConflictException('This incident is already resolved');
    if (row.status === 'acknowledged') return this.detail(auth, id);

    const changed = await this.db.tx(async (tx) => {
      const count = await tx.run(
        `UPDATE incidents
            SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $3::uuid,
                assignee_id = COALESCE(assignee_id, $3::uuid), updated_at = now()
          WHERE id = $1 AND org_id = $2 AND status = 'open'`,
        [id, auth.orgId, auth.user.id],
      );
      if (count === 0) return false;
      await skipPendingJobs(tx, id, 'The incident was acknowledged');
      const note = input.message ? `: ${input.message}` : '';
      await addIncidentEvent(
        tx,
        id,
        auth.orgId,
        'acknowledged',
        `${auth.user.name} acknowledged the incident${note}`,
        auth.user.id,
      );
      return true;
    });
    if (changed) this.publish(auth.orgId, id, row.number, 'updated');
    return this.detail(auth, id);
  }

  async resolve(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<IncidentDetail> {
    const input = parseWith(closeSchema, body);
    const row = await this.requireJoined(auth.orgId, id);
    if (row.status === 'resolved') return this.detail(auth, id);

    const note = input.message ? `: ${input.message}` : '';
    const closed = await this.db.tx((tx) =>
      closeIncident(tx, id, {
        resolvedAt: null,
        by: auth.user.id,
        resolution: 'manual',
        message: `${auth.user.name} marked the incident as resolved${note}`,
      }),
    );
    if (closed) this.publish(auth.orgId, id, row.number, 'resolved');
    return this.detail(auth, id);
  }

  async assign(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<IncidentDetail> {
    const input = parseWith(assignSchema, body);
    const row = await this.requireJoined(auth.orgId, id);
    let label = 'Unassigned';
    if (input.userId) {
      await assertMembers(this.db, auth.orgId, [input.userId]);
      const person = (
        await loadMembers(this.db, auth.orgId, [input.userId])
      ).get(input.userId);
      label = `Assigned to ${person?.name ?? 'a teammate'}`;
    }
    await this.db.tx(async (tx) => {
      await tx.run(
        'UPDATE incidents SET assignee_id = $3::uuid, updated_at = now() WHERE id = $1 AND org_id = $2',
        [id, auth.orgId, input.userId],
      );
      await addIncidentEvent(
        tx,
        id,
        auth.orgId,
        'assigned',
        `${auth.user.name}: ${label}`,
        auth.user.id,
      );
    });
    this.publish(auth.orgId, id, row.number, 'updated');
    return this.detail(auth, id);
  }

  async addNote(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<IncidentDetail> {
    const input = parseWith(noteSchema, body);
    const row = await this.requireJoined(auth.orgId, id);
    await addIncidentEvent(
      this.db,
      id,
      auth.orgId,
      'note',
      input.message,
      auth.user.id,
    );
    this.publish(auth.orgId, id, row.number, 'updated');
    return this.detail(auth, id);
  }

  async setPostmortem(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<IncidentDetail> {
    const input = parseWith(postmortemSchema, body);
    const row = await this.requireJoined(auth.orgId, id);
    if (input.text.trim() === row.postmortem.trim())
      return this.detail(auth, id);
    await this.db.tx(async (tx) => {
      await tx.run(
        `UPDATE incidents SET postmortem = $3, postmortem_updated_at = now(), updated_at = now()
          WHERE id = $1 AND org_id = $2`,
        [id, auth.orgId, input.text],
      );
      await addIncidentEvent(
        tx,
        id,
        auth.orgId,
        'postmortem',
        `${auth.user.name} ${row.postmortem.trim() ? 'updated' : 'wrote'} the postmortem`,
        auth.user.id,
      );
    });
    this.publish(auth.orgId, id, row.number, 'updated');
    return this.detail(auth, id);
  }

  private publish(
    orgId: string,
    incidentId: string,
    number: number,
    change: 'opened' | 'updated' | 'resolved',
  ) {
    this.bus.publish(orgId, { type: 'incident', incidentId, number, change });
  }

  private async requireJoined(
    orgId: string,
    id: string,
  ): Promise<IncidentJoinRow> {
    const row = await this.db.row<IncidentJoinRow>(
      `${INCIDENT_SELECT} WHERE i.id = $1 AND i.org_id = $2`,
      [id, orgId],
    );
    if (!row) throw notFound('Incident');
    return row;
  }
}
