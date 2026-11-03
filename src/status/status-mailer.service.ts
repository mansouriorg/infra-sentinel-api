import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { PublicStatusService } from './public.service';
import { assembleStatus } from './status.assemble';
import { notificationMessage } from './status.mail';
import {
  PENDING,
  newestAt,
  planNotifications,
  type Candidate,
  type NotifiedRow,
} from './status.notify';
import { publicIncidentId } from './status.model';
import type { PageRow } from './status.rows';
import { toMs } from '../common/time';

const TICK_MS = 60_000;
const STALE_SUBSCRIBER_DAYS = 7;

interface NotifiedDb {
  incident_id: string;
  last_state: string;
  last_update_at: Date | null;
  attempts: number;
}

@Injectable()
export class StatusMailer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatusMailer.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly status: PublicStatusService,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('SCHEDULER_ENABLED')) {
      this.logger.log('Status page mailer is off (SCHEDULER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.loop(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now: number = Date.now()): Promise<number> {
    await this.db.run(
      `DELETE FROM status_subscribers WHERE confirmed_at IS NULL AND created_at < now() - ($1::int * interval '1 day')`,
      [STALE_SUBSCRIBER_DAYS],
    );
    const pages = await this.db.rows<{ id: string }>(
      'SELECT id FROM status_pages WHERE published ORDER BY created_at',
    );
    let sent = 0;
    for (const page of pages) {
      if (this.stopping) break;
      try {
        sent += await this.processPage(page.id, now);
      } catch (error) {
        this.logger.error(
          `Status page ${page.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return sent;
  }

  private async loop(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      await this.tick();
    } finally {
      this.busy = false;
    }
  }

  private async processPage(pageId: string, now: number): Promise<number> {
    return this.db.tx(async (tx) => {
      const page = await tx.row<PageRow>(
        'SELECT * FROM status_pages WHERE id = $1 AND published FOR UPDATE SKIP LOCKED',
        [pageId],
      );
      if (!page) return 0;

      const input = await this.status.load(page, now);
      const model = assembleStatus(input);
      const byPublicId = new Map(
        input.incidents.map((incident) => [
          publicIncidentId(page.id, incident.id),
          incident.id,
        ]),
      );
      const candidates: Candidate[] = [...model.active, ...model.past].flatMap(
        (incident) => {
          const incidentId = byPublicId.get(incident.id);
          return incidentId ? [{ incidentId, incident }] : [];
        },
      );
      if (candidates.length === 0) return 0;

      const rows = await tx.rows<NotifiedDb>(
        'SELECT incident_id, last_state, last_update_at, attempts FROM status_notified WHERE page_id = $1 AND incident_id = ANY($2::uuid[])',
        [page.id, candidates.map((candidate) => candidate.incidentId)],
      );
      const notified = new Map<string, NotifiedRow>(
        rows.map((row) => [
          row.incident_id,
          {
            incidentId: row.incident_id,
            lastState: row.last_state,
            lastUpdateAt: row.last_update_at ? toMs(row.last_update_at) : null,
            attempts: row.attempts,
          },
        ]),
      );
      const plan = planNotifications(
        candidates,
        notified,
        now,
        toMs(page.created_at),
      );
      if (plan.send.length === 0 && plan.seed.length === 0) return 0;

      const subscribers = await tx.rows<{ email: string; token: string }>(
        'SELECT email, token FROM status_subscribers WHERE page_id = $1 AND confirmed_at IS NOT NULL ORDER BY created_at',
        [page.id],
      );
      const base = this.status.baseUrl(page);
      let delivered = 0;

      const record = async (
        incidentId: string,
        state: string,
        updateAt: number,
        attempts: number,
      ) => {
        await tx.run(
          `INSERT INTO status_notified (page_id, incident_id, last_state, last_update_at, attempts, updated_at)
           VALUES ($1, $2, $3, to_timestamp($4::float8 / 1000), $5::int, now())
           ON CONFLICT (page_id, incident_id) DO UPDATE SET
             last_state = EXCLUDED.last_state, last_update_at = EXCLUDED.last_update_at,
             attempts = EXCLUDED.attempts, updated_at = now()`,
          [page.id, incidentId, state, updateAt, attempts],
        );
      };

      for (const item of plan.seed)
        await record(item.incidentId, item.state, item.updateAt, 0);

      for (const item of plan.send) {
        let ok = 0;
        for (const subscriber of subscribers) {
          const unsubscribeUrl = `${base}/unsubscribe?token=${encodeURIComponent(subscriber.token)}`;
          const message = notificationMessage({
            to: subscriber.email,
            kind: item.kind,
            pageName: page.name,
            incident: item.incident,
            pageUrl: base,
            unsubscribeUrl,
          });
          if (await this.mail.send(message)) ok += 1;
        }
        delivered += ok;
        if (subscribers.length > 0 && ok === 0) {
          const previous = notified.get(item.incidentId);
          const previousState =
            previous && previous.lastState !== PENDING
              ? previous.lastState
              : PENDING;
          await record(
            item.incidentId,
            previousState,
            previous?.lastUpdateAt ?? 0,
            item.attempts + 1,
          );
        } else {
          await record(item.incidentId, item.state, newestAt(item.incident), 0);
        }
      }
      return delivered;
    });
  }
}
