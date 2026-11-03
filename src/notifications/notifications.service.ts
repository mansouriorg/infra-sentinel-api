import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditEntry } from '../audit/audit.types';
import type { AuthContext } from '../auth/auth.types';
import { toIso } from '../common/time';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { EventBus } from '../monitors/event-bus';
import type { LiveEvent } from '../monitors/monitor.types';
import { parseWith } from '../monitors/monitor.schema';
import { hasRole } from '../orgs/roles';
import { NOTICE_CATEGORIES } from '../preferences/preferences.types';
import { serverStatus } from '../servers/server.format';
import {
  KEY_EXPIRY_WARNING_DAYS,
  NOTICE_KINDS,
  markReadSchema,
  noticeQuerySchema,
  type NoticeInput,
  type NoticePage,
  type NoticeView,
} from './notifications.types';

const HOUR = 3_600_000;

interface NoticeRow {
  id: string | number;
  kind: string;
  category: string;
  data: Record<string, unknown> | null;
  created_at: Date | string;
  read: boolean;
}

interface IncidentRow {
  number: number;
  title: string;
  severity: string;
  monitor_name: string;
}

interface ServerRow {
  name: string;
  last_seen_at: Date | string | null;
  interval_sec: number;
}

const ALL_CATEGORIES = [...NOTICE_CATEGORIES];

const VISIBLE = `
  n.org_id = $1
  AND n.created_at >= m.created_at
  AND (n.audience = 'all' OR $3::boolean)
  AND n.category = ANY(COALESCE(p.notify_categories, $4::text[]))
`;

const JOINS = `
  FROM inbox_notices n
  JOIN memberships m ON m.org_id = n.org_id AND m.user_id = $2
  LEFT JOIN user_preferences p ON p.user_id = $2
  LEFT JOIN inbox_state s ON s.user_id = $2 AND s.org_id = n.org_id
`;

const READ_TEST = `(n.id <= COALESCE(s.read_through, 0) OR EXISTS (SELECT 1 FROM inbox_reads r WHERE r.user_id = $2 AND r.notice_id = n.id))`;

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly running = new Set<Promise<unknown>>();
  private stop?: () => void;
  private stopAudit?: () => void;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly bus: EventBus,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.stop = this.bus.tap((orgId, event) => {
      const task = this.handle(orgId, event).catch((error: unknown) => {
        this.logger.warn(
          `Could not write a notification: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      this.running.add(task);
      void task.finally(() => this.running.delete(task));
    });
    this.stopAudit = this.audit.onRecord((entry) => {
      const task = this.fromAudit(entry).catch(() => undefined);
      this.running.add(task);
      void task.finally(() => this.running.delete(task));
    });
    if (!this.config.get('SCHEDULER_ENABLED')) return;
    this.timer = setInterval(() => void this.housekeeping(), HOUR);
    this.timer.unref();
    setTimeout(() => void this.housekeeping(), 30_000).unref();
  }

  onModuleDestroy(): void {
    this.stop?.();
    this.stopAudit?.();
    if (this.timer) clearInterval(this.timer);
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  async handle(orgId: string, event: LiveEvent): Promise<void> {
    if (
      event.type === 'incident' &&
      (event.change === 'opened' || event.change === 'resolved')
    ) {
      const incident = await this.db.row<IncidentRow>(
        'SELECT number, title, severity, monitor_name FROM incidents WHERE id = $1 AND org_id = $2',
        [event.incidentId, orgId],
      );
      if (!incident) return;
      await this.publish({
        orgId,
        kind:
          event.change === 'opened' ? 'incident.opened' : 'incident.resolved',
        data: {
          incidentId: event.incidentId,
          number: incident.number,
          title: incident.title,
          severity: incident.severity,
          monitor: incident.monitor_name,
        },
        dedupe: `incident:${event.incidentId}:${event.change}`,
      });
      return;
    }
    if (event.type === 'server' && event.change === 'status') {
      const server = await this.db.row<ServerRow>(
        'SELECT name, last_seen_at, interval_sec FROM servers WHERE id = $1 AND org_id = $2',
        [event.serverId, orgId],
      );
      if (!server) return;
      const status = serverStatus(
        server.last_seen_at ? new Date(server.last_seen_at) : null,
        server.interval_sec,
        new Date(),
      );
      if (status !== 'offline' && status !== 'online') return;
      await this.publish({
        orgId,
        kind: status === 'offline' ? 'server.offline' : 'server.online',
        data: { serverId: event.serverId, name: server.name },
      });
    }
  }

  async fromAudit(entry: AuditEntry): Promise<void> {
    if (entry.action === 'invites.accept') {
      await this.publish({
        orgId: entry.orgId,
        kind: 'team.member_joined',
        data: { email: entry.actorLabel },
      });
    } else if (entry.action === 'auth.sso_provision') {
      await this.publish({
        orgId: entry.orgId,
        kind: 'team.member_joined',
        data: { email: entry.actorLabel, name: entry.summary ?? '' },
      });
    } else if (entry.action === 'webhooks.auto_disable') {
      await this.publish({
        orgId: entry.orgId,
        kind: 'webhook.disabled',
        data: {
          name: entry.summary ?? '',
          reason: String(entry.metadata?.reason ?? ''),
        },
      });
    }
  }

  async publish(input: NoticeInput): Promise<boolean> {
    try {
      const rule = NOTICE_KINDS[input.kind];
      const rows = await this.db.rows<{ id: string | number }>(
        `INSERT INTO inbox_notices (org_id, audience, category, kind, data, dedupe)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (org_id, dedupe) WHERE dedupe IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          input.orgId,
          rule.audience,
          rule.category,
          input.kind,
          JSON.stringify(input.data),
          input.dedupe ?? null,
        ],
      );
      if (rows.length === 0) return false;
      this.bus.publish(input.orgId, { type: 'notification' });
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not write notification ${input.kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async list(
    auth: AuthContext,
    raw: Record<string, string | undefined>,
  ): Promise<NoticePage> {
    const query = parseWith(noticeQuerySchema, raw);
    const base = [
      auth.orgId,
      auth.user.id,
      hasRole(auth.role, 'admin'),
      ALL_CATEGORIES,
    ];
    const unreadRow = await this.db.row<{ count: string }>(
      `SELECT count(*) AS count ${JOINS} WHERE ${VISIBLE} AND NOT ${READ_TEST}`,
      base,
    );
    const values: unknown[] = [...base];
    const extra: string[] = [];
    if (query.before) {
      values.push(query.before);
      extra.push(`n.id < $${values.length}::bigint`);
    }
    if (query.unread) extra.push(`NOT ${READ_TEST}`);
    values.push(query.limit + 1);
    const rows = await this.db.rows<NoticeRow>(
      `SELECT n.id, n.kind, n.category, n.data, n.created_at, ${READ_TEST} AS read
         ${JOINS}
        WHERE ${VISIBLE} ${extra.map((clause) => `AND ${clause}`).join(' ')}
        ORDER BY n.id DESC
        LIMIT $${values.length}`,
      values,
    );
    const page = rows.slice(0, query.limit).map(toView);
    return {
      items: page,
      unread: Number(unreadRow?.count ?? 0),
      nextBefore: rows.length > query.limit ? page[page.length - 1].id : null,
    };
  }

  async markRead(
    auth: AuthContext,
    body: unknown,
  ): Promise<{ unread: number }> {
    const input = parseWith(markReadSchema, body);
    if (input.all) {
      await this.db.tx(async (tx) => {
        await tx.run(
          `INSERT INTO inbox_state (user_id, org_id, read_through)
           SELECT $1, $2, COALESCE(max(id), 0) FROM inbox_notices WHERE org_id = $2
           ON CONFLICT (user_id, org_id) DO UPDATE
             SET read_through = GREATEST(inbox_state.read_through, EXCLUDED.read_through)`,
          [auth.user.id, auth.orgId],
        );
        await tx.run(
          `DELETE FROM inbox_reads r USING inbox_notices n, inbox_state s
            WHERE r.notice_id = n.id AND n.org_id = $2 AND s.user_id = $1 AND s.org_id = $2
              AND r.user_id = $1 AND n.id <= s.read_through`,
          [auth.user.id, auth.orgId],
        );
      });
    } else {
      await this.db.run(
        `INSERT INTO inbox_reads (user_id, notice_id)
         SELECT $1, n.id FROM inbox_notices n WHERE n.org_id = $2 AND n.id = ANY($3::bigint[])
         ON CONFLICT DO NOTHING`,
        [auth.user.id, auth.orgId, input.ids],
      );
    }
    const page = await this.list(auth, { limit: '1' });
    return { unread: page.unread };
  }

  async housekeeping(): Promise<void> {
    await this.purge();
    await this.warnAboutKeys();
  }

  async purge(): Promise<number> {
    try {
      return await this.db.run(
        `DELETE FROM inbox_notices WHERE created_at < now() - ($1::int * interval '1 day')`,
        [this.config.get('NOTIFICATION_RETENTION_DAYS')],
      );
    } catch (error) {
      this.logger.warn(
        `Notification cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  async warnAboutKeys(): Promise<number> {
    try {
      const keys = await this.db.rows<{
        id: string;
        org_id: string;
        name: string;
        prefix: string;
        expires_at: Date | string;
      }>(
        `SELECT id, org_id, name, prefix, expires_at FROM api_keys
          WHERE revoked_at IS NULL AND expires_at > now()
            AND expires_at < now() + ($1::int * interval '1 day')`,
        [KEY_EXPIRY_WARNING_DAYS],
      );
      let written = 0;
      for (const key of keys) {
        const added = await this.publish({
          orgId: key.org_id,
          kind: 'api_key.expiring',
          data: {
            name: key.name,
            prefix: key.prefix,
            expiresAt: toIso(key.expires_at),
          },
          dedupe: `api-key:${key.id}:expiring`,
        });
        if (added) written += 1;
      }
      return written;
    } catch (error) {
      this.logger.warn(
        `API key expiry check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }
}

function toView(row: NoticeRow): NoticeView {
  return {
    id: String(row.id),
    kind: row.kind,
    category: row.category as NoticeView['category'],
    data: row.data ?? {},
    createdAt: toIso(row.created_at),
    read: row.read,
  };
}
