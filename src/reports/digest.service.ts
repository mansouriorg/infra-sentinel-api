import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { DAY_MS } from './availability';
import { describeSchedule, isDue } from './digest.schedule';
import { digestMessage } from './digest.mail';
import { formatDay } from './report.build';
import { digestSchema, parseWith, type DigestInput } from './report.schema';
import { ReportService } from './report.service';
import type { ResolvedPeriod } from './report.types';
import { toIso, toMs } from '../common/time';

const TICK_MS = 60_000;

interface DigestRow {
  org_id: string;
  enabled: boolean;
  weekday: number;
  hour: number;
  time_zone: string;
  recipients: 'admins' | 'everyone';
  extra_emails: string[] | null;
  last_sent_at: Date | null;
}

export interface DigestView {
  enabled: boolean;
  weekday: number;
  hour: number;
  timeZone: string;
  recipients: 'admins' | 'everyone';
  extraEmails: string[];
  lastSentAt: string | null;
  schedule: string;
  recipientCount: number;
}

const DEFAULTS = {
  enabled: false,
  weekday: 1,
  hour: 8,
  timeZone: 'UTC',
  recipients: 'admins' as const,
  extraEmails: [] as string[],
};

@Injectable()
export class DigestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DigestService.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly reports: ReportService,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('SCHEDULER_ENABLED')) {
      this.logger.log('Digest scheduler is off (SCHEDULER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.loop(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  async get(auth: AuthContext): Promise<DigestView> {
    const row = await this.db.row<DigestRow>(
      'SELECT * FROM digest_settings WHERE org_id = $1',
      [auth.orgId],
    );
    return this.view(auth.orgId, row);
  }

  async update(auth: AuthContext, body: unknown): Promise<DigestView> {
    const input = parseWith(digestSchema, body);
    const before = await this.db.row<DigestRow>(
      'SELECT * FROM digest_settings WHERE org_id = $1',
      [auth.orgId],
    );
    const turningOn = input.enabled && !before?.enabled;
    const row = await this.db.row<DigestRow>(
      `INSERT INTO digest_settings (org_id, enabled, weekday, hour, time_zone, recipients, extra_emails, last_sent_at)
       VALUES ($1, $2, $3::int, $4::int, $5, $6, $7::text[], CASE WHEN $2::boolean THEN now() END)
       ON CONFLICT (org_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, weekday = EXCLUDED.weekday, hour = EXCLUDED.hour, time_zone = EXCLUDED.time_zone,
         recipients = EXCLUDED.recipients, extra_emails = EXCLUDED.extra_emails,
         last_sent_at = CASE WHEN $8::boolean THEN now() ELSE digest_settings.last_sent_at END,
         updated_at = now()
       RETURNING *`,
      [
        auth.orgId,
        input.enabled,
        input.weekday,
        input.hour,
        input.timeZone,
        input.recipients,
        input.extraEmails,
        turningOn,
      ],
    );
    return this.view(auth.orgId, row);
  }

  async sendTest(auth: AuthContext): Promise<{ sent: boolean; to: string }> {
    const now = Date.now();
    const report = await this.reports.buildFor(
      auth.orgId,
      this.weekBefore(now),
      99.9,
      false,
      {
        monitorIds: [],
        serverIds: [],
        tags: [],
      },
      now,
    );
    const sent = await this.mail.send(
      digestMessage(auth.user.email, report, this.reportUrl()),
    );
    return { sent, to: auth.user.email };
  }

  async tick(now: number = Date.now()): Promise<number> {
    const rows = await this.db.rows<DigestRow>(
      'SELECT * FROM digest_settings WHERE enabled',
    );
    let delivered = 0;
    for (const row of rows) {
      const { due, scheduledAt } = isDue(
        now,
        row.last_sent_at ? toMs(row.last_sent_at) : null,
        {
          weekday: row.weekday,
          hour: row.hour,
          timeZone: row.time_zone,
        },
      );
      if (!due) continue;
      const claimed = await this.db.run(
        `UPDATE digest_settings SET last_sent_at = to_timestamp($2::float8 / 1000)
          WHERE org_id = $1 AND enabled AND (last_sent_at IS NULL OR last_sent_at < to_timestamp($3::float8 / 1000))`,
        [row.org_id, now, scheduledAt],
      );
      if (claimed === 0) continue;
      const result = await this.sendFor(row, scheduledAt);
      if (result.recipients > 0 && result.sent === 0) {
        await this.db.run(
          'UPDATE digest_settings SET last_sent_at = $2::timestamptz WHERE org_id = $1',
          [row.org_id, row.last_sent_at],
        );
      } else {
        delivered += result.sent;
      }
    }
    return delivered;
  }

  private async loop(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      await this.tick();
    } catch (error) {
      if (!this.stopping)
        this.logger.error(
          `Digest tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      this.busy = false;
    }
  }

  private async sendFor(
    row: DigestRow,
    scheduledAt: number,
  ): Promise<{ recipients: number; sent: number }> {
    const recipients = await this.recipients(
      row.org_id,
      row.recipients,
      row.extra_emails ?? [],
    );
    if (recipients.length === 0) return { recipients: 0, sent: 0 };
    const report = await this.reports.buildFor(
      row.org_id,
      this.weekBefore(scheduledAt),
      99.9,
      false,
      {
        monitorIds: [],
        serverIds: [],
        tags: [],
      },
      scheduledAt,
    );
    let sent = 0;
    for (const email of recipients) {
      if (await this.mail.send(digestMessage(email, report, this.reportUrl())))
        sent += 1;
    }
    return { recipients: recipients.length, sent };
  }

  private weekBefore(end: number): ResolvedPeriod {
    const from = end - 7 * DAY_MS;
    return {
      from,
      to: end,
      label: `${formatDay(from)} to ${formatDay(end)}`,
      days: 7,
    };
  }

  private reportUrl(): string {
    return `${this.config.get('WEB_URL').replace(/\/+$/, '')}/reports`;
  }

  private async recipients(
    orgId: string,
    mode: 'admins' | 'everyone',
    extra: string[],
  ): Promise<string[]> {
    const members = await this.db.rows<{ email: string }>(
      `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND ($2::text = 'everyone' OR m.role IN ('owner', 'admin'))`,
      [orgId, mode],
    );
    return [
      ...new Set([
        ...members.map((member) => member.email.toLowerCase()),
        ...extra.map((email) => email.toLowerCase()),
      ]),
    ];
  }

  private async view(
    orgId: string,
    row: DigestRow | undefined,
  ): Promise<DigestView> {
    const settings: DigestInput = row
      ? {
          enabled: row.enabled,
          weekday: row.weekday,
          hour: row.hour,
          timeZone: row.time_zone,
          recipients: row.recipients,
          extraEmails: row.extra_emails ?? [],
        }
      : DEFAULTS;
    const recipients = await this.recipients(
      orgId,
      settings.recipients,
      settings.extraEmails,
    );
    return {
      ...settings,
      lastSentAt: row?.last_sent_at ? toIso(row.last_sent_at) : null,
      schedule: describeSchedule(
        settings.weekday,
        settings.hour,
        settings.timeZone,
      ),
      recipientCount: recipients.length,
    };
  }
}
