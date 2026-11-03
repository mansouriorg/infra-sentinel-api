import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EventBus } from './event-bus';
import { iso } from './monitor.format';
import { applyOutcome, describeEvent, nextDelaySeconds } from './monitor.state';
import type { CheckOutcome, LiveEvent, MonitorRow } from './monitor.types';

const UPSERT_ROLLUP = `
  INSERT INTO monitor_rollups (monitor_id, bucket, checks, ups, timed, sum_ms, min_ms, max_ms)
  VALUES ($1, date_trunc('hour', now()), 1, $2::int, $3::int, $4::bigint, $5::int, $5::int)
  ON CONFLICT (monitor_id, bucket) DO UPDATE SET
    checks = monitor_rollups.checks + 1,
    ups = monitor_rollups.ups + EXCLUDED.ups,
    timed = monitor_rollups.timed + EXCLUDED.timed,
    sum_ms = monitor_rollups.sum_ms + EXCLUDED.sum_ms,
    min_ms = LEAST(monitor_rollups.min_ms, EXCLUDED.min_ms),
    max_ms = GREATEST(monitor_rollups.max_ms, EXCLUDED.max_ms)`;

const UPDATE_MONITOR = `
  UPDATE monitors SET
    status = $2,
    status_since = CASE WHEN $3::boolean THEN now() ELSE status_since END,
    consecutive_failures = $4::int,
    last_checked_at = now(),
    last_response_ms = $5::int,
    last_message = $6::text,
    next_check_at = now() + ($7::float8 * interval '1 second'),
    ssl_expires_at = COALESCE($8::timestamptz, ssl_expires_at),
    updated_at = now()
  WHERE id = $1`;

interface Recorded {
  orgId: string;
  events: LiveEvent[];
}

@Injectable()
export class RecorderService {
  constructor(
    private readonly db: DatabaseService,
    private readonly bus: EventBus,
  ) {}

  async record(monitorId: string, result: CheckOutcome): Promise<boolean> {
    const recorded = await this.db.tx<Recorded | null>(async (tx) => {
      const row = await tx.row<MonitorRow>(
        'SELECT * FROM monitors WHERE id = $1 FOR UPDATE',
        [monitorId],
      );
      if (!row || row.paused) return null;

      const message = result.message.slice(0, 500);
      await tx.run(
        `INSERT INTO check_results (monitor_id, status, response_ms, status_code, message)
         VALUES ($1, $2, $3::int, $4::int, $5)`,
        [
          monitorId,
          result.status,
          result.responseMs,
          result.statusCode,
          message,
        ],
      );
      await tx.run(UPSERT_ROLLUP, [
        monitorId,
        result.status === 'down' ? 0 : 1,
        result.responseMs === null ? 0 : 1,
        result.responseMs ?? 0,
        result.responseMs,
      ]);

      const threshold = row.type === 'heartbeat' ? 1 : row.failure_threshold;
      const transition = applyOutcome(
        { status: row.status, consecutiveFailures: row.consecutive_failures },
        result.status,
        threshold,
      );
      const delay = nextDelaySeconds({
        type: row.type,
        intervalSec: row.interval_sec,
        graceSec: Number(row.config?.graceSec ?? 0),
        outcome: result.status,
        confirmedDown: transition.status === 'down',
      });

      await tx.run(UPDATE_MONITOR, [
        monitorId,
        transition.status,
        transition.changed,
        transition.consecutiveFailures,
        result.responseMs,
        message,
        delay,
        result.sslExpiresAt,
      ]);

      const at = new Date();
      const events: LiveEvent[] = [
        {
          type: 'check',
          monitorId,
          status: transition.status,
          checkStatus: result.status,
          responseMs: result.responseMs,
          message,
          at: iso(at),
        },
      ];

      if (transition.event) {
        const downFor =
          transition.event === 'up' && row.status === 'down'
            ? Math.max(0, at.getTime() - new Date(row.status_since).getTime())
            : 0;
        const text = describeEvent(
          transition.event,
          row.name,
          message,
          downFor,
        );
        await tx.run(
          `INSERT INTO monitor_events (monitor_id, org_id, kind, message) VALUES ($1, $2, $3, $4)`,
          [monitorId, row.org_id, transition.event, text],
        );
        events.push({
          type: 'status',
          monitorId,
          name: row.name,
          from: row.status,
          to: transition.status,
          kind: transition.event,
          message: text,
          at: iso(at),
        });
      }
      return { orgId: row.org_id, events };
    });

    if (!recorded) return false;
    for (const event of recorded.events)
      this.bus.publish(recorded.orgId, event);
    return true;
  }
}
