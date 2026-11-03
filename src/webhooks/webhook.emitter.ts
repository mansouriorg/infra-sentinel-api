import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { toDate, toIso } from '../common/time';
import { DatabaseService } from '../database/database.service';
import { EventBus } from '../monitors/event-bus';
import { describeTarget } from '../monitors/monitor.schema';
import type { LiveEvent, MonitorType } from '../monitors/monitor.types';
import { serverStatus } from '../servers/server.format';
import {
  MAX_PENDING_PER_ENDPOINT,
  envelope,
  eventTypeFor,
  scrubTarget,
  type WebhookEventType,
} from './webhook.events';

type Data = Record<string, unknown>;

interface MonitorRow {
  id: string;
  name: string;
  type: MonitorType;
  config: Record<string, any>;
  interval_sec: number;
  status: string;
  paused: boolean;
  tags: string[];
}

interface IncidentRow {
  id: string;
  number: number;
  title: string;
  cause: string;
  severity: string;
  status: string;
  trigger: string;
  monitor_id: string | null;
  monitor_name: string;
  started_at: Date | string;
  acknowledged_at: Date | string | null;
  resolved_at: Date | string | null;
  resolution: string | null;
}

interface ServerRow {
  id: string;
  name: string;
  hostname: string;
  tags: string[];
  last_seen_at: Date | string | null;
  interval_sec: number;
}

const optionalIso = (value: Date | string | null): string | null =>
  value ? toIso(value) : null;

@Injectable()
export class WebhookEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookEmitter.name);
  private readonly running = new Set<Promise<unknown>>();
  private stop?: () => void;

  constructor(
    private readonly db: DatabaseService,
    private readonly bus: EventBus,
  ) {}

  onModuleInit(): void {
    this.stop = this.bus.tap((orgId, event) => {
      const task = this.handle(orgId, event).catch((error: unknown) => {
        this.logger.warn(
          `Could not queue webhook events: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 0;
      });
      this.running.add(task);
      void task.finally(() => this.running.delete(task));
    });
  }

  onModuleDestroy(): void {
    this.stop?.();
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  async handle(orgId: string, event: LiveEvent): Promise<number> {
    const type = eventTypeFor(event);
    if (!type) return 0;
    const endpoints = await this.db.rows<{ id: string }>(
      'SELECT id FROM webhook_endpoints WHERE org_id = $1 AND enabled AND $2 = ANY(events)',
      [orgId, type],
    );
    if (endpoints.length === 0) return 0;
    const data = await this.describe(orgId, event);
    if (!data) return 0;
    return this.enqueue(
      orgId,
      type,
      data,
      endpoints.map((endpoint) => endpoint.id),
    );
  }

  async enqueue(
    orgId: string,
    type: WebhookEventType,
    data: Data,
    endpointIds: string[],
  ): Promise<number> {
    const eventId = randomUUID();
    const payload = JSON.stringify(envelope(eventId, type, orgId, data));
    let queued = 0;
    for (const endpointId of endpointIds) {
      queued += await this.db.run(
        `INSERT INTO webhook_deliveries (endpoint_id, org_id, event_id, event_type, payload)
         SELECT $1, $2, $3, $4, $5::jsonb
          WHERE (SELECT count(*) FROM webhook_deliveries WHERE endpoint_id = $1 AND status = 'pending') < $6`,
        [endpointId, orgId, eventId, type, payload, MAX_PENDING_PER_ENDPOINT],
      );
    }
    return queued;
  }

  private async describe(
    orgId: string,
    event: LiveEvent,
  ): Promise<Data | null> {
    switch (event.type) {
      case 'status': {
        const monitor = await this.monitor(orgId, event.monitorId);
        return {
          monitor: monitor ?? { id: event.monitorId, name: event.name },
          from: event.from,
          to: event.to,
          kind: event.kind,
          message: event.message,
          at: event.at,
        };
      }
      case 'monitor': {
        if (event.change === 'deleted')
          return { monitor: { id: event.monitorId } };
        const monitor = await this.monitor(orgId, event.monitorId);
        return monitor ? { monitor } : null;
      }
      case 'incident': {
        const incident = await this.incident(orgId, event.incidentId);
        return incident ? { incident } : null;
      }
      case 'server': {
        if (event.change === 'deleted')
          return { server: { id: event.serverId } };
        const server = await this.server(orgId, event.serverId);
        return server ? { server } : null;
      }
      default:
        return null;
    }
  }

  private async monitor(orgId: string, id: string): Promise<Data | null> {
    const row = await this.db.row<MonitorRow>(
      'SELECT id, name, type, config, interval_sec, status, paused, tags FROM monitors WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      target: scrubTarget(
        describeTarget(row.type, row.config, row.interval_sec),
      ),
      status: row.status,
      paused: row.paused,
      tags: row.tags,
    };
  }

  private async incident(orgId: string, id: string): Promise<Data | null> {
    const row = await this.db.row<IncidentRow>(
      `SELECT id, number, title, cause, severity, status, trigger, monitor_id, monitor_name,
              started_at, acknowledged_at, resolved_at, resolution
         FROM incidents WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (!row) return null;
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      cause: row.cause,
      severity: row.severity,
      status: row.status,
      trigger: row.trigger,
      monitor: row.monitor_id
        ? { id: row.monitor_id, name: row.monitor_name }
        : null,
      startedAt: toIso(row.started_at),
      acknowledgedAt: optionalIso(row.acknowledged_at),
      resolvedAt: optionalIso(row.resolved_at),
      resolution: row.resolution,
    };
  }

  private async server(orgId: string, id: string): Promise<Data | null> {
    const row = await this.db.row<ServerRow>(
      'SELECT id, name, hostname, tags, last_seen_at, interval_sec FROM servers WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      tags: row.tags,
      status: serverStatus(
        row.last_seen_at ? toDate(row.last_seen_at) : null,
        row.interval_sec,
        new Date(),
      ),
      lastSeenAt: optionalIso(row.last_seen_at),
    };
  }
}
