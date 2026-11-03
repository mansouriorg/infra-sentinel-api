import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { toIso } from '../common/time';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { parseWith } from '../monitors/monitor.schema';
import { toCsv } from '../reports/report.csv';
import {
  CSV_LIMIT,
  auditQuerySchema,
  buildAuditQuery,
  clip,
} from './audit.actions';
import type {
  ActorType,
  AuditEntry,
  AuditPage,
  AuditView,
} from './audit.types';

interface AuditRow {
  id: string | number;
  actor_type: ActorType;
  actor_id: string | null;
  actor_label: string;
  action: string;
  target_type: string;
  target_id: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Date | string;
}

const HOUR = 3_600_000;

function toView(row: AuditRow): AuditView {
  return {
    id: String(row.id),
    at: toIso(row.created_at),
    actor: { type: row.actor_type, id: row.actor_id, label: row.actor_label },
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    summary: row.summary,
    metadata: row.metadata ?? {},
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private timer?: ReturnType<typeof setInterval>;
  private readonly listeners = new Set<(entry: AuditEntry) => void>();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.purge(), 6 * HOUR);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  onRecord(listener: (entry: AuditEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.run(
        `INSERT INTO audit_events (org_id, actor_type, actor_id, actor_label, action, target_type, target_id, summary, metadata, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
        [
          entry.orgId,
          entry.actorType,
          entry.actorId,
          clip(entry.actorLabel, 200),
          entry.action,
          entry.targetType ?? '',
          entry.targetId ?? '',
          clip(entry.summary ?? '', 200),
          JSON.stringify(entry.metadata ?? {}),
          entry.ip ? entry.ip.slice(0, 64) : null,
          entry.userAgent ? entry.userAgent.slice(0, 255) : null,
        ],
      );
    } catch (error) {
      this.logger.warn(
        `Could not write audit event ${entry.action}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(entry);
      } catch (error) {
        this.logger.warn(
          `An audit listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async recordForUser(
    userId: string,
    entry: Omit<AuditEntry, 'orgId'>,
  ): Promise<void> {
    try {
      const orgs = await this.db.rows<{ org_id: string }>(
        'SELECT org_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 20',
        [userId],
      );
      for (const org of orgs)
        await this.record({ ...entry, orgId: org.org_id });
    } catch (error) {
      this.logger.warn(
        `Could not write audit event ${entry.action}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async list(
    auth: AuthContext,
    raw: Record<string, string | undefined>,
  ): Promise<AuditPage | string> {
    const query = parseWith(auditQuerySchema, raw);
    const built = buildAuditQuery(auth.orgId, query);
    const rows = await this.db.rows<AuditRow>(built.text, built.values);
    const limit = query.format === 'csv' ? CSV_LIMIT : query.limit;
    const page = rows.slice(0, limit).map(toView);
    if (query.format === 'csv') return this.toCsv(page);
    return {
      items: page,
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async purge(): Promise<number> {
    try {
      return await this.db.run(
        `DELETE FROM audit_events WHERE created_at < now() - ($1::int * interval '1 day')`,
        [this.config.get('AUDIT_RETENTION_DAYS')],
      );
    } catch (error) {
      this.logger.warn(
        `Audit cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  private toCsv(items: AuditView[]): string {
    return toCsv(
      [
        'Time (UTC)',
        'Actor type',
        'Actor',
        'Action',
        'Target type',
        'Target',
        'Summary',
        'IP address',
      ],
      items.map((item) => [
        item.at,
        item.actor.type,
        item.actor.label,
        item.action,
        item.targetType,
        item.targetId,
        item.summary,
        item.ip,
      ]),
    );
  }
}
