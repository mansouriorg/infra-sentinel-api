import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { postRequest, snippet } from '../alerting/channels/http-post';
import { AuditService } from '../audit/audit.service';
import { SecretBox } from '../common/secret-box';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import {
  AUTO_DISABLE_AFTER,
  MAX_ATTEMPTS,
  backoffSeconds,
  signature,
} from './webhook.events';

const TICK_MS = 5_000;
const BATCH = 20;
const PARALLEL = 5;
const LEASE_SEC = 300;
const PURGE_EVERY_MS = 3_600_000;
const TIMEOUT_MS = 10_000;

interface Due {
  id: string;
  endpoint_id: string;
  org_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
}

interface EndpointRow {
  id: string;
  org_id: string;
  name: string;
  url: string;
  secret_enc: string;
  enabled: boolean;
}

interface Outcome {
  ok: boolean;
  status: number | null;
  snippet: string;
  error: string;
  ms: number;
}

@Injectable()
export class WebhookWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private lastPurge = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly secrets: SecretBox,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('SCHEDULER_ENABLED')) {
      this.logger.log('Webhook delivery is off (SCHEDULER_ENABLED=false)');
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
    const claimed = await this.db.rows<Due>(
      `UPDATE webhook_deliveries d
          SET next_attempt_at = now() + ($1::int * interval '1 second')
        WHERE d.id IN (
          SELECT id FROM webhook_deliveries
           WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING d.id, d.endpoint_id, d.org_id, d.event_id, d.event_type, d.payload, d.attempts`,
      [LEASE_SEC, BATCH],
    );
    for (let i = 0; i < claimed.length; i += PARALLEL) {
      if (this.stopping) break;
      await Promise.all(
        claimed.slice(i, i + PARALLEL).map((row) => this.safely(row)),
      );
    }
    if (now - this.lastPurge > PURGE_EVERY_MS) {
      this.lastPurge = now;
      await this.purge();
    }
    return claimed.length;
  }

  async attempt(deliveryId: string): Promise<boolean> {
    const rows = await this.db.rows<Due>(
      `UPDATE webhook_deliveries
          SET next_attempt_at = now() + ($1::int * interval '1 second')
        WHERE id = $2 AND status = 'pending'
        RETURNING id, endpoint_id, org_id, event_id, event_type, payload, attempts`,
      [LEASE_SEC, deliveryId],
    );
    if (rows.length === 0) return false;
    await this.safely(rows[0]);
    return true;
  }

  async purge(): Promise<number> {
    try {
      return await this.db.run(
        `DELETE FROM webhook_deliveries WHERE created_at < now() - ($1::int * interval '1 day')`,
        [this.config.get('WEBHOOK_RETENTION_DAYS')],
      );
    } catch (error) {
      this.logger.warn(
        `Webhook cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  private async loop(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      await this.tick();
    } catch (error) {
      this.logger.warn(
        `Webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy = false;
    }
  }

  private async safely(row: Due): Promise<void> {
    try {
      await this.process(row);
    } catch (error) {
      this.logger.error(
        `Delivery ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async process(row: Due): Promise<void> {
    const endpoint = await this.db.row<EndpointRow>(
      'SELECT id, org_id, name, url, secret_enc, enabled FROM webhook_endpoints WHERE id = $1',
      [row.endpoint_id],
    );
    if (!endpoint) return;
    const isTest = row.event_type === 'test.ping';
    if (!endpoint.enabled && !isTest) {
      await this.settle(
        row,
        endpoint,
        {
          ok: false,
          status: null,
          snippet: '',
          error: 'This endpoint is turned off',
          ms: 0,
        },
        true,
      );
      return;
    }
    const outcome = await this.send(row, endpoint);
    await this.settle(row, endpoint, outcome, isTest);
  }

  private async send(row: Due, endpoint: EndpointRow): Promise<Outcome> {
    let secret: string;
    try {
      secret = this.secrets.open(endpoint.secret_enc);
    } catch {
      return {
        ok: false,
        status: null,
        snippet: '',
        error:
          'The signing secret could not be read. Create a new one for this endpoint.',
        ms: 0,
      };
    }
    const body = JSON.stringify(row.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const started = Date.now();
    try {
      const response = await postRequest(endpoint.url, {
        body,
        timeoutMs: TIMEOUT_MS,
        blockPrivate: this.config.get('BLOCK_PRIVATE_TARGETS'),
        headers: {
          'user-agent': 'InfraSentinel-Webhooks/1.0',
          'x-sentinel-event': row.event_type,
          'x-sentinel-delivery': row.id,
          'x-sentinel-signature': signature(secret, body, timestamp),
        },
      });
      const ok = response.status >= 200 && response.status < 300;
      return {
        ok,
        status: response.status,
        snippet: snippet(response.body),
        error: ok ? '' : `The endpoint answered with HTTP ${response.status}`,
        ms: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        snippet: '',
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started,
      };
    }
  }

  private async settle(
    row: Due,
    endpoint: EndpointRow,
    outcome: Outcome,
    final: boolean,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const isTest = row.event_type === 'test.ping';
    if (outcome.ok) {
      await this.db.run(
        `UPDATE webhook_deliveries
            SET status = 'success', attempts = $2, response_status = $3, response_snippet = $4, error = '',
                duration_ms = $5, last_attempt_at = now(), delivered_at = now()
          WHERE id = $1`,
        [row.id, attempts, outcome.status, outcome.snippet, outcome.ms],
      );
      if (!isTest) {
        await this.db.run(
          'UPDATE webhook_endpoints SET consecutive_failures = 0, last_success_at = now() WHERE id = $1',
          [endpoint.id],
        );
      }
      return;
    }

    if (final || attempts >= MAX_ATTEMPTS) {
      await this.db.run(
        `UPDATE webhook_deliveries
            SET status = 'failed', attempts = $2, response_status = $3, response_snippet = $4, error = $5,
                duration_ms = $6, last_attempt_at = now()
          WHERE id = $1`,
        [
          row.id,
          attempts,
          outcome.status,
          outcome.snippet,
          outcome.error,
          outcome.ms,
        ],
      );
      if (!isTest && endpoint.enabled) await this.countFailure(endpoint);
      return;
    }

    await this.db.run(
      `UPDATE webhook_deliveries
          SET attempts = $2, response_status = $3, response_snippet = $4, error = $5, duration_ms = $6,
              last_attempt_at = now(), next_attempt_at = now() + ($7::int * interval '1 second')
        WHERE id = $1`,
      [
        row.id,
        attempts,
        outcome.status,
        outcome.snippet,
        outcome.error,
        outcome.ms,
        backoffSeconds(attempts),
      ],
    );
  }

  private async countFailure(endpoint: EndpointRow): Promise<void> {
    const reason = `Turned off after ${AUTO_DISABLE_AFTER} deliveries in a row failed`;
    const disabled = await this.db.tx(async (tx) => {
      const current = await tx.row<{
        consecutive_failures: number;
        enabled: boolean;
      }>(
        'SELECT consecutive_failures, enabled FROM webhook_endpoints WHERE id = $1 FOR UPDATE',
        [endpoint.id],
      );
      if (!current) return false;
      const next = current.consecutive_failures + 1;
      const turnOff = current.enabled && next >= AUTO_DISABLE_AFTER;
      await tx.run(
        `UPDATE webhook_endpoints
            SET consecutive_failures = $2, last_failure_at = now(), updated_at = now(),
                enabled = $3, disabled_reason = $4
          WHERE id = $1`,
        [endpoint.id, next, current.enabled && !turnOff, turnOff ? reason : ''],
      );
      if (turnOff) {
        await tx.run(
          `UPDATE webhook_deliveries SET status = 'failed', error = 'The endpoint was turned off'
            WHERE endpoint_id = $1 AND status = 'pending'`,
          [endpoint.id],
        );
      }
      return turnOff;
    });
    if (disabled) await this.announceDisabled(endpoint, reason);
  }

  private async announceDisabled(
    endpoint: EndpointRow,
    reason: string,
  ): Promise<void> {
    await this.audit.record({
      orgId: endpoint.org_id,
      actorType: 'system',
      actorId: null,
      actorLabel: 'Infra Sentinel',
      action: 'webhooks.auto_disable',
      targetType: 'webhooks',
      targetId: endpoint.id,
      summary: endpoint.name,
      metadata: { reason },
    });
    try {
      const admins = await this.db.rows<{ email: string; name: string }>(
        `SELECT u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.org_id = $1 AND m.role IN ('owner', 'admin')`,
        [endpoint.org_id],
      );
      const url = `${this.config.get('WEB_URL').replace(/\/+$/, '')}/settings#developers`;
      for (const admin of admins) {
        await this.mail.sendNotice(
          admin.email,
          admin.name,
          `Webhook "${endpoint.name}" was turned off`,
          `${reason}. Fix the receiving end, then turn the webhook on again in your settings. Events that happen meanwhile are not queued for it.`,
          url,
          'Open webhook settings',
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not email about a disabled webhook: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
