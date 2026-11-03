import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/auth.types';
import { RateLimits } from '../common/rate-limits';
import { SecretBox } from '../common/secret-box';
import { toIso } from '../common/time';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { parseWith } from '../monitors/monitor.schema';
import {
  MAX_ENDPOINTS,
  WEBHOOK_EVENTS,
  checkWebhookUrl,
  createWebhookSchema,
  deliveryQuerySchema,
  envelope,
  newSecret,
  updateWebhookSchema,
  type EventInfo,
} from './webhook.events';
import { WebhookWorker } from './webhook.worker';

export interface WebhookView {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  disabledReason: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
  pending: number;
}

export interface DeliveryView {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  responseSnippet: string;
  error: string;
  durationMs: number | null;
  createdAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
}

export interface DeliveryDetail extends DeliveryView {
  payload: unknown;
}

export interface DeliveryPage {
  items: DeliveryView[];
  nextBefore: string | null;
}

interface EndpointRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  disabled_reason: string;
  consecutive_failures: number;
  last_success_at: Date | string | null;
  last_failure_at: Date | string | null;
  created_at: Date | string;
  pending: string | number;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  next_attempt_at: Date | string;
  response_status: number | null;
  response_snippet: string;
  error: string;
  duration_ms: number | null;
  created_at: Date | string;
  last_attempt_at: Date | string | null;
  delivered_at: Date | string | null;
  payload?: unknown;
}

const optionalIso = (value: Date | string | null): string | null =>
  value ? toIso(value) : null;

const ENDPOINT_SQL = `
  SELECT e.id, e.name, e.url, e.events, e.enabled, e.disabled_reason, e.consecutive_failures,
         e.last_success_at, e.last_failure_at, e.created_at,
         (SELECT count(*) FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'pending') AS pending
    FROM webhook_endpoints e`;

const DELIVERY_COLUMNS = `d.id, d.endpoint_id, d.event_id, d.event_type, d.status, d.attempts, d.next_attempt_at,
  d.response_status, d.response_snippet, d.error, d.duration_ms, d.created_at, d.last_attempt_at, d.delivered_at`;

function endpointView(row: EndpointRow): WebhookView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    disabledReason: row.disabled_reason,
    consecutiveFailures: row.consecutive_failures,
    lastSuccessAt: optionalIso(row.last_success_at),
    lastFailureAt: optionalIso(row.last_failure_at),
    createdAt: toIso(row.created_at),
    pending: Number(row.pending),
  };
}

function deliveryView(row: DeliveryRow): DeliveryView {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventId: row.event_id,
    eventType: row.event_type,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.status === 'pending' ? toIso(row.next_attempt_at) : null,
    responseStatus: row.response_status,
    responseSnippet: row.response_snippet,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: toIso(row.created_at),
    lastAttemptAt: optionalIso(row.last_attempt_at),
    deliveredAt: optionalIso(row.delivered_at),
  };
}

@Injectable()
export class WebhooksService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly secrets: SecretBox,
    private readonly limits: RateLimits,
    private readonly worker: WebhookWorker,
  ) {}

  events(): readonly EventInfo[] {
    return WEBHOOK_EVENTS;
  }

  async list(auth: AuthContext): Promise<WebhookView[]> {
    const rows = await this.db.rows<EndpointRow>(
      `${ENDPOINT_SQL} WHERE e.org_id = $1 ORDER BY e.created_at`,
      [auth.orgId],
    );
    return rows.map(endpointView);
  }

  async create(
    auth: AuthContext,
    body: unknown,
  ): Promise<{ endpoint: WebhookView; secret: string }> {
    const input = parseWith(createWebhookSchema, body);
    this.assertUrl(input.url);
    const secret = newSecret();
    const id = await this.db.tx(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `webhooks:${auth.orgId}`,
      ]);
      const count = await tx.row<{ count: string }>(
        'SELECT count(*) AS count FROM webhook_endpoints WHERE org_id = $1',
        [auth.orgId],
      );
      if (Number(count?.count ?? 0) >= MAX_ENDPOINTS) {
        throw new BadRequestException(
          `This organization already has ${MAX_ENDPOINTS} webhooks. Remove one first.`,
        );
      }
      const row = await tx.row<{ id: string }>(
        `INSERT INTO webhook_endpoints (org_id, name, url, secret_enc, events, created_by)
         VALUES ($1, $2, $3, $4, $5::text[], $6) RETURNING id`,
        [
          auth.orgId,
          input.name,
          input.url,
          this.secrets.seal(secret),
          input.events,
          auth.user.id,
        ],
      );
      if (!row) throw new Error('The webhook was not saved');
      return row.id;
    });
    return { endpoint: await this.view(auth.orgId, id), secret };
  }

  async update(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<WebhookView> {
    const input = parseWith(updateWebhookSchema, body);
    if (input.url !== undefined) this.assertUrl(input.url);
    await this.require(auth.orgId, id);
    const reset = input.enabled === true;
    await this.db.run(
      `UPDATE webhook_endpoints
          SET name = COALESCE($3, name),
              url = COALESCE($4, url),
              events = COALESCE($5::text[], events),
              enabled = COALESCE($6, enabled),
              consecutive_failures = CASE WHEN $7 THEN 0 ELSE consecutive_failures END,
              disabled_reason = CASE WHEN $6 IS NOT NULL THEN CASE WHEN $6 THEN '' ELSE 'Turned off by an administrator' END ELSE disabled_reason END,
              updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [
        id,
        auth.orgId,
        input.name ?? null,
        input.url ?? null,
        input.events ?? null,
        input.enabled ?? null,
        reset,
      ],
    );
    if (input.enabled === false) {
      await this.db.run(
        `UPDATE webhook_deliveries SET status = 'failed', error = 'The endpoint was turned off'
          WHERE endpoint_id = $1 AND status = 'pending'`,
        [id],
      );
    }
    return this.view(auth.orgId, id);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    const removed = await this.db.run(
      'DELETE FROM webhook_endpoints WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
    if (removed === 0) throw new NotFoundException('Webhook not found');
  }

  async rotateSecret(
    auth: AuthContext,
    id: string,
  ): Promise<{ endpoint: WebhookView; secret: string }> {
    await this.require(auth.orgId, id);
    const secret = newSecret();
    await this.db.run(
      'UPDATE webhook_endpoints SET secret_enc = $3, updated_at = now() WHERE id = $1 AND org_id = $2',
      [id, auth.orgId, this.secrets.seal(secret)],
    );
    return { endpoint: await this.view(auth.orgId, id), secret };
  }

  async test(auth: AuthContext, id: string): Promise<DeliveryDetail> {
    const decision = this.limits.hit(
      `webhook-test:${auth.user.id}`,
      10,
      60_000,
    );
    if (!decision.allowed)
      throw new HttpException(
        'Too many tests. Wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const endpoint = await this.require(auth.orgId, id);
    const eventId = randomUUID();
    const payload = envelope(eventId, 'test.ping', auth.orgId, {
      message: 'This is a test event from Infra Sentinel.',
      webhook: { id: endpoint.id, name: endpoint.name },
    });
    const row = await this.db.row<{ id: string }>(
      `INSERT INTO webhook_deliveries (endpoint_id, org_id, event_id, event_type, payload, next_attempt_at)
       VALUES ($1, $2, $3, 'test.ping', $4::jsonb, now() + interval '10 minutes') RETURNING id`,
      [id, auth.orgId, eventId, JSON.stringify(payload)],
    );
    if (!row) throw new Error('The test was not queued');
    await this.worker.attempt(row.id);
    return this.deliveryDetail(auth.orgId, row.id);
  }

  async deliveries(
    auth: AuthContext,
    id: string,
    raw: Record<string, string | undefined>,
  ): Promise<DeliveryPage> {
    const query = parseWith(deliveryQuerySchema, raw);
    await this.require(auth.orgId, id);
    const values: unknown[] = [id, auth.orgId];
    const where = ['d.endpoint_id = $1', 'd.org_id = $2'];
    if (query.status) {
      values.push(query.status);
      where.push(`d.status = $${values.length}`);
    }
    if (query.before) {
      values.push(query.before);
      where.push(`d.created_at < $${values.length}::timestamptz`);
    }
    values.push(query.limit + 1);
    const rows = await this.db.rows<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries d
        WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT $${values.length}`,
      values,
    );
    const page = rows.slice(0, query.limit).map(deliveryView);
    return {
      items: page,
      nextBefore:
        rows.length > query.limit ? page[page.length - 1].createdAt : null,
    };
  }

  async delivery(
    auth: AuthContext,
    deliveryId: string,
  ): Promise<DeliveryDetail> {
    return this.deliveryDetail(auth.orgId, deliveryId);
  }

  async redeliver(
    auth: AuthContext,
    deliveryId: string,
  ): Promise<DeliveryDetail> {
    const decision = this.limits.hit(
      `webhook-redeliver:${auth.user.id}`,
      30,
      60_000,
    );
    if (!decision.allowed)
      throw new HttpException(
        'Too many requests. Wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const source = await this.db.row<{
      endpoint_id: string;
      event_id: string;
      event_type: string;
      payload: unknown;
      enabled: boolean;
    }>(
      `SELECT d.endpoint_id, d.event_id, d.event_type, d.payload, e.enabled
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.id = $1 AND d.org_id = $2`,
      [deliveryId, auth.orgId],
    );
    if (!source) throw new NotFoundException('Delivery not found');
    if (!source.enabled)
      throw new BadRequestException(
        'Turn the webhook on before sending this again',
      );
    const row = await this.db.row<{ id: string }>(
      `INSERT INTO webhook_deliveries (endpoint_id, org_id, event_id, event_type, payload, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now() + interval '10 minutes') RETURNING id`,
      [
        source.endpoint_id,
        auth.orgId,
        source.event_id,
        source.event_type,
        JSON.stringify(source.payload),
      ],
    );
    if (!row) throw new Error('The delivery was not queued');
    await this.worker.attempt(row.id);
    return this.deliveryDetail(auth.orgId, row.id);
  }

  private assertUrl(url: string): void {
    const problem = checkWebhookUrl(
      url,
      this.config.get('BLOCK_PRIVATE_TARGETS'),
    );
    if (problem) throw new BadRequestException(problem);
  }

  private async require(
    orgId: string,
    id: string,
  ): Promise<{ id: string; name: string }> {
    const row = await this.db.row<{ id: string; name: string }>(
      'SELECT id, name FROM webhook_endpoints WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (!row) throw new NotFoundException('Webhook not found');
    return row;
  }

  private async view(orgId: string, id: string): Promise<WebhookView> {
    const row = await this.db.row<EndpointRow>(
      `${ENDPOINT_SQL} WHERE e.id = $1 AND e.org_id = $2`,
      [id, orgId],
    );
    if (!row) throw new NotFoundException('Webhook not found');
    return endpointView(row);
  }

  private async deliveryDetail(
    orgId: string,
    id: string,
  ): Promise<DeliveryDetail> {
    const row = await this.db.row<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS}, d.payload FROM webhook_deliveries d WHERE d.id = $1 AND d.org_id = $2`,
      [id, orgId],
    );
    if (!row) throw new NotFoundException('Delivery not found');
    return { ...deliveryView(row), payload: row.payload };
  }
}
