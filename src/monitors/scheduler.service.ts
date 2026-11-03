import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { CheckRunner } from './checks/runner';
import { RecorderService } from './recorder.service';
import type { MonitorType } from './monitor.types';

const TICK_MS = 1000;
const PURGE_EVERY_MS = 3_600_000;
const FIRST_PURGE_MS = 60_000;
const PURGE_BATCH = 5000;
const KEEP_SUMMARIES_DAYS = 400;

const CLAIM_SQL = `
  WITH due AS (
    SELECT id FROM monitors
     WHERE NOT paused AND next_check_at <= now()
     ORDER BY next_check_at
     LIMIT $1::int
       FOR UPDATE SKIP LOCKED
  )
  UPDATE monitors m
     SET next_check_at = now() + (((m.timeout_ms / 1000.0) + 30)::float8 * interval '1 second')
    FROM due
   WHERE m.id = due.id
  RETURNING m.id, m.type, m.config, m.timeout_ms`;

const GRACE_SQL = `
  UPDATE monitors
     SET next_check_at = now() + ((interval_sec + COALESCE((config->>'graceSec')::int, 60))::float8 * interval '1 second')
   WHERE type = 'heartbeat' AND NOT paused AND next_check_at < now()`;

const PURGE_RESULTS_SQL = `
  DELETE FROM check_results
   WHERE id IN (
     SELECT id FROM check_results
      WHERE checked_at < now() - ($1::int * interval '1 day')
      LIMIT $2::int
   )`;

interface Claimed {
  id: string;
  type: MonitorType;
  config: Record<string, any>;
  timeout_ms: number;
}

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly inflight = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private nextPurgeAt = Date.now() + FIRST_PURGE_MS;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly runner: CheckRunner,
    private readonly recorder: RecorderService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get('SCHEDULER_ENABLED')) {
      this.logger.log('Scheduler is off (SCHEDULER_ENABLED=false)');
      return;
    }
    await this.db.run(GRACE_SQL);
    this.timer = setInterval(() => void this.loop(), TICK_MS);
    this.timer.unref();
    this.logger.log(
      `Scheduler running, up to ${this.config.get('SCHEDULER_CONCURRENCY')} checks at once`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.drain(10_000);
  }

  async tick(): Promise<number> {
    const free = this.config.get('SCHEDULER_CONCURRENCY') - this.inflight.size;
    if (free <= 0) return 0;
    const due = await this.db.rows<Claimed>(CLAIM_SQL, [free]);
    for (const monitor of due) this.launch(monitor);
    return due.length;
  }

  async drain(timeoutMs = 15_000): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([
      Promise.allSettled([...this.inflight]).then(() => undefined),
      limit,
    ]);
    if (timer) clearTimeout(timer);
  }

  async purge(): Promise<number> {
    const days = this.config.get('RESULT_RETENTION_DAYS');
    let removed = 0;
    for (let round = 0; round < 200; round += 1) {
      const count = await this.db.run(PURGE_RESULTS_SQL, [days, PURGE_BATCH]);
      removed += count;
      if (count < PURGE_BATCH) break;
    }
    await this.db.run(
      `DELETE FROM monitor_rollups WHERE bucket < now() - ($1::int * interval '1 day')`,
      [KEEP_SUMMARIES_DAYS],
    );
    await this.db.run(
      `DELETE FROM monitor_events WHERE at < now() - ($1::int * interval '1 day')`,
      [KEEP_SUMMARIES_DAYS],
    );
    return removed;
  }

  private async loop(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      await this.tick();
      if (Date.now() >= this.nextPurgeAt) {
        this.nextPurgeAt = Date.now() + PURGE_EVERY_MS;
        const removed = await this.purge();
        if (removed > 0)
          this.logger.log(`Removed ${removed} old check results`);
      }
    } catch (error) {
      if (!this.stopping)
        this.logger.error(`Scheduler tick failed: ${reason(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private launch(monitor: Claimed): void {
    const task: Promise<void> = this.execute(monitor)
      .catch((error: unknown) => {
        if (!this.stopping)
          this.logger.error(`Check ${monitor.id} failed: ${reason(error)}`);
      })
      .finally(() => {
        this.inflight.delete(task);
      });
    this.inflight.add(task);
  }

  private async execute(monitor: Claimed): Promise<void> {
    const result = await this.runner.run(
      monitor.type,
      monitor.config,
      monitor.timeout_ms,
    );
    await this.recorder.record(monitor.id, result);
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
