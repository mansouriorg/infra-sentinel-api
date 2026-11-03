import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Scope } from '../alerting/alert.types';
import { RateLimiter } from '../common/rate-limiter';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import {
  dayStarts,
  type Interval,
  type WindowSpec,
} from '../reports/availability';
import { pausedIntervals, type PauseRow } from '../reports/report.service';
import { serverStatus } from '../servers/server.format';
import {
  assembleStatus,
  type AssembleInput,
  type ComponentInput,
  type IncidentInput,
  type UpdateInput,
  type WindowInput,
} from './status.assemble';
import { confirmationMessage } from './status.mail';
import { monitorComponentStatus, serverComponentStatus } from './status.model';
import { publicBase, toPublicInfo, type PageRow } from './status.rows';
import { subscribeSchema, tokenSchema } from './status.schema';
import type { IncidentState, PublicStatus } from './status.types';
import { toDate, toMs } from '../common/time';

const CACHE_MAX = 500;
const CONFIRM_RESEND_MS = 10 * 60_000;
const SUBSCRIBE_LIMIT = 5;
const SUBSCRIBE_WINDOW_MS = 3_600_000;
const SUBSCRIBE_PER_ADDRESS = 6;
const SUBSCRIBE_PER_IP = 20;
const DAY_MS = 86_400_000;

interface ComponentRow {
  kind: 'monitor' | 'server';
  label: string;
  group_name: string;
  position: number;
  monitor_id: string | null;
  server_id: string | null;
  monitor_status: string | null;
  monitor_paused: boolean | null;
  monitor_tags: string[] | null;
  monitor_created: Date | null;
  server_tags: string[] | null;
  server_created: Date | null;
  server_seen: Date | null;
  server_interval: number | null;
}

interface IncidentRowLite {
  id: string;
  source: 'monitor' | 'server';
  monitor_id: string | null;
  server_id: string | null;
  trigger: 'down' | 'degraded';
  status: 'open' | 'acknowledged' | 'resolved';
  started_at: Date;
  resolved_at: Date | null;
  public_title: string;
}

interface UpdateRowLite {
  incident_id: string;
  state: IncidentState;
  message: string;
  created_at: Date;
}

interface WindowRowLite {
  id: string;
  name: string;
  starts_at: Date;
  duration_sec: number;
  repeat: WindowSpec['repeat'];
  scope_all: boolean;
  monitor_ids: string[] | null;
  tags: string[] | null;
}

export type SubscribeOutcome = 'ok' | 'rate_limited' | 'invalid';

@Injectable()
export class PublicStatusService {
  cacheMs = 10_000;
  private readonly cache = new Map<
    string,
    { at: number; value: PublicStatus }
  >();
  private readonly limiter = new RateLimiter();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly mail: MailService,
  ) {}

  baseUrl(
    page: Pick<PageRow, 'slug' | 'custom_domain' | 'domain_verified_at'>,
  ): string {
    return publicBase(this.config.get('WEB_URL'), page);
  }

  invalidate(pageId?: string): void {
    if (pageId) this.cache.delete(pageId);
    else this.cache.clear();
  }

  findPublished(slug: string): Promise<PageRow | undefined> {
    return this.db.row<PageRow>(
      'SELECT * FROM status_pages WHERE slug = $1 AND published',
      [slug],
    );
  }

  async model(page: PageRow, now: number = Date.now()): Promise<PublicStatus> {
    const cached = this.cache.get(page.id);
    if (cached && now - cached.at < this.cacheMs) return cached.value;
    const value = assembleStatus(await this.load(page, now));
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(page.id, { at: now, value });
    return value;
  }

  async load(page: PageRow, now: number = Date.now()): Promise<AssembleInput> {
    const firstDay = dayStarts(now, page.history_days)[0];
    const components = await this.db.rows<ComponentRow>(
      `SELECT c.kind, c.label, c.group_name, c.position, c.monitor_id, c.server_id,
              m.status AS monitor_status, m.paused AS monitor_paused, m.tags AS monitor_tags, m.created_at AS monitor_created,
              s.tags AS server_tags, s.created_at AS server_created, s.last_seen_at AS server_seen, s.interval_sec AS server_interval
         FROM status_components c
         LEFT JOIN monitors m ON m.id = c.monitor_id
         LEFT JOIN servers s ON s.id = c.server_id
        WHERE c.page_id = $1
        ORDER BY c.position, lower(c.label)`,
      [page.id],
    );
    const monitorIds = components.flatMap((row) =>
      row.monitor_id ? [row.monitor_id] : [],
    );
    const serverIds = components.flatMap((row) =>
      row.server_id ? [row.server_id] : [],
    );

    const [incidents, windows, pauses] = await Promise.all([
      this.db.rows<IncidentRowLite>(
        `SELECT id, source, monitor_id, server_id, trigger, status, started_at, resolved_at, public_title
           FROM incidents
          WHERE org_id = $1 AND NOT public_hidden
            AND ((source = 'monitor' AND monitor_id = ANY($2::uuid[]))
              OR (source = 'server' AND server_metric = 'offline' AND server_id = ANY($3::uuid[])))
            AND (status <> 'resolved' OR resolved_at >= to_timestamp($4::float8 / 1000))
          ORDER BY started_at DESC
          LIMIT 500`,
        [page.org_id, monitorIds, serverIds, firstDay],
      ),
      this.db.rows<WindowRowLite>(
        `SELECT id, name, starts_at, duration_sec, repeat, scope_all, monitor_ids, tags
           FROM maintenance_windows WHERE org_id = $1 AND public`,
        [page.org_id],
      ),
      monitorIds.length === 0
        ? Promise.resolve([] as PauseRow[])
        : this.db.rows<PauseRow>(
            `SELECT monitor_id, kind, at FROM monitor_events
              WHERE monitor_id = ANY($1::uuid[]) AND kind IN ('paused', 'resumed') AND at < to_timestamp($2::float8 / 1000)
              ORDER BY monitor_id, at`,
            [monitorIds, now],
          ),
    ]);
    const updates =
      incidents.length === 0
        ? []
        : await this.db.rows<UpdateRowLite>(
            `SELECT incident_id, state, message, created_at FROM status_updates
              WHERE incident_id = ANY($1::uuid[]) ORDER BY created_at`,
            [incidents.map((row) => row.id)],
          );

    const pausesBy = new Map<string, PauseRow[]>();
    for (const row of pauses) {
      const list = pausesBy.get(row.monitor_id) ?? [];
      list.push(row);
      pausesBy.set(row.monitor_id, list);
    }

    const componentInputs: ComponentInput[] = components.map((row) => {
      if (row.kind === 'monitor') {
        const paused = Boolean(row.monitor_paused);
        const intervals: Interval[] = pausedIntervals(
          pausesBy.get(row.monitor_id as string) ?? [],
          paused,
          now,
        );
        return {
          kind: 'monitor',
          subjectId: row.monitor_id as string,
          label: row.label,
          group: row.group_name,
          position: row.position,
          tags: row.monitor_tags ?? [],
          createdAt: toMs(row.monitor_created as Date),
          status: monitorComponentStatus(
            row.monitor_status ?? 'pending',
            paused,
          ),
          paused: intervals,
        };
      }
      return {
        kind: 'server',
        subjectId: row.server_id as string,
        label: row.label,
        group: row.group_name,
        position: row.position,
        tags: row.server_tags ?? [],
        createdAt: toMs(row.server_created as Date),
        status: serverComponentStatus(
          serverStatus(
            row.server_seen ? toDate(row.server_seen) : null,
            row.server_interval ?? 15,
            new Date(now),
          ),
        ),
        paused: [],
      };
    });

    const incidentInputs: IncidentInput[] = incidents.flatMap((row) => {
      const subjectId =
        row.source === 'monitor' ? row.monitor_id : row.server_id;
      if (!subjectId) return [];
      return [
        {
          id: row.id,
          kind: row.source,
          subjectId,
          trigger: row.trigger,
          resolved: row.status === 'resolved',
          startedAt: toMs(row.started_at),
          resolvedAt: row.resolved_at ? toMs(row.resolved_at) : null,
          publicTitle: row.public_title,
        },
      ];
    });

    const updateInputs: UpdateInput[] = updates.map((row) => ({
      incidentId: row.incident_id,
      state: row.state,
      message: row.message,
      at: toMs(row.created_at),
    }));

    const windowInputs: WindowInput[] = windows.map((row) => ({
      id: row.id,
      name: row.name,
      spec: {
        startsAt: toDate(row.starts_at),
        durationSec: row.duration_sec,
        repeat: row.repeat,
      },
      scope: {
        all: row.scope_all,
        monitorIds: row.monitor_ids ?? [],
        tags: row.tags ?? [],
      } satisfies Scope,
    }));

    return {
      pageId: page.id,
      page: toPublicInfo(page),
      now,
      components: componentInputs,
      incidents: incidentInputs,
      updates: updateInputs,
      windows: windowInputs,
    };
  }

  async subscribe(
    page: PageRow,
    rawEmail: unknown,
    ip: string,
  ): Promise<SubscribeOutcome> {
    const parsed = subscribeSchema.safeParse({ email: rawEmail });
    if (!parsed.success) return 'invalid';
    if (
      !this.limiter.attempt(
        `subscribe:${ip}:${page.id}`,
        SUBSCRIBE_LIMIT,
        SUBSCRIBE_WINDOW_MS,
      )
    )
      return 'rate_limited';
    if (
      !this.limiter.attempt(
        `subscribe-ip:${ip}`,
        SUBSCRIBE_PER_IP,
        SUBSCRIBE_WINDOW_MS,
      )
    )
      return 'rate_limited';
    const email = parsed.data.email;
    if (
      !this.limiter.attempt(
        `subscribe-to:${email}`,
        SUBSCRIBE_PER_ADDRESS,
        DAY_MS,
      )
    )
      return 'rate_limited';
    const existing = await this.db.row<{
      id: string;
      token: string;
      confirmed_at: Date | null;
      confirmation_sent_at: Date | null;
    }>(
      'SELECT id, token, confirmed_at, confirmation_sent_at FROM status_subscribers WHERE page_id = $1 AND email = $2',
      [page.id, email],
    );
    if (existing?.confirmed_at) return 'ok';
    if (
      existing?.confirmation_sent_at &&
      Date.now() - toMs(existing.confirmation_sent_at) < CONFIRM_RESEND_MS
    )
      return 'ok';
    const token = existing?.token ?? randomBytes(24).toString('base64url');
    if (existing) {
      await this.db.run(
        'UPDATE status_subscribers SET confirmation_sent_at = now() WHERE id = $1',
        [existing.id],
      );
    } else {
      await this.db.run(
        `INSERT INTO status_subscribers (page_id, email, token, confirmation_sent_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (page_id, email) DO NOTHING`,
        [page.id, email, token],
      );
    }
    const base = publicBase(this.config.get('WEB_URL'), {
      slug: page.slug,
      custom_domain: null,
      domain_verified_at: null,
    });
    await this.mail.send(
      confirmationMessage(
        email,
        page.name,
        `${base}/confirm?token=${encodeURIComponent(token)}`,
      ),
    );
    return 'ok';
  }

  async confirm(page: PageRow, token: unknown): Promise<boolean> {
    if (!tokenSchema.safeParse(token).success) return false;
    const changed = await this.db.run(
      'UPDATE status_subscribers SET confirmed_at = COALESCE(confirmed_at, now()) WHERE token = $1 AND page_id = $2',
      [token, page.id],
    );
    return changed > 0;
  }

  async knowsToken(page: PageRow, token: unknown): Promise<boolean> {
    if (!tokenSchema.safeParse(token).success) return false;
    const row = await this.db.row<{ id: string }>(
      'SELECT id FROM status_subscribers WHERE token = $1 AND page_id = $2',
      [token, page.id],
    );
    return Boolean(row);
  }

  async unsubscribe(page: PageRow, token: unknown): Promise<boolean> {
    if (!tokenSchema.safeParse(token).success) return false;
    const removed = await this.db.run(
      'DELETE FROM status_subscribers WHERE token = $1 AND page_id = $2',
      [token, page.id],
    );
    return removed > 0;
  }
}
