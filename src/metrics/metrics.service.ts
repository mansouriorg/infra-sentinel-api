import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { Registry } from './registry';

const REFRESH_MS = 10_000;
const REQUEST_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
const MONITOR_STATUSES = ['pending', 'up', 'degraded', 'down', 'paused'];
const SERVER_STATUSES = ['pending', 'online', 'offline'];
const INCIDENT_STATUSES = ['open', 'acknowledged'];
const INCIDENT_SEVERITIES = ['critical', 'warning', 'info'];
const DELIVERY_STATUSES = ['pending', 'success', 'failed'];

interface Counted {
  key: string;
  second?: string;
  n: number;
}

interface Snapshot {
  size: number;
  organizations: number;
  users: number;
  monitors: Counted[];
  overdue: number;
  checks: number;
  incidents: Counted[];
  servers: Counted[];
  jobsDue: number;
  jobsOldest: number;
  deliveries: Counted[];
  deliveriesDue: number;
}

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  readonly registry = new Registry();
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  private refreshedAt = 0;
  private pending?: Promise<void>;

  private readonly requests = this.registry.counter(
    'sentinel_http_requests_total',
    'HTTP requests answered by the API.',
  );
  private readonly durations = this.registry.histogram(
    'sentinel_http_request_duration_seconds',
    'Time the API took to answer a request.',
    REQUEST_BUCKETS,
  );
  private readonly buildInfo = this.registry.gauge(
    'sentinel_build_info',
    'Version of the running API. The value is always 1.',
  );
  private readonly databaseUp = this.registry.gauge(
    'sentinel_database_up',
    '1 when PostgreSQL answers, 0 when it does not.',
  );
  private readonly databaseSize = this.registry.gauge(
    'sentinel_database_size_bytes',
    'Size of the PostgreSQL database.',
  );
  private readonly pool = this.registry.gauge(
    'sentinel_database_pool_connections',
    'Connections in the API database pool.',
  );
  private readonly organizations = this.registry.gauge(
    'sentinel_organizations',
    'Workspaces.',
  );
  private readonly users = this.registry.gauge(
    'sentinel_users',
    'People with an account.',
  );
  private readonly monitors = this.registry.gauge(
    'sentinel_monitors',
    'Monitors by status.',
  );
  private readonly overdue = this.registry.gauge(
    'sentinel_monitors_overdue',
    'Monitors whose next check is more than a minute late. A growing number means the scheduler is stuck or overloaded.',
  );
  private readonly checks = this.registry.gauge(
    'sentinel_checks_last_minute',
    'Checks that finished in the last minute.',
  );
  private readonly incidents = this.registry.gauge(
    'sentinel_incidents_active',
    'Incidents that are not resolved.',
  );
  private readonly servers = this.registry.gauge(
    'sentinel_servers',
    'Servers by status.',
  );
  private readonly jobsDue = this.registry.gauge(
    'sentinel_alert_jobs_due',
    'Alert messages that are due and not sent yet.',
  );
  private readonly jobsOldest = this.registry.gauge(
    'sentinel_alert_jobs_oldest_age_seconds',
    'How long the oldest due alert message has been waiting.',
  );
  private readonly deliveries = this.registry.gauge(
    'sentinel_webhook_deliveries_last_hour',
    'Webhook deliveries created in the last hour by status.',
  );
  private readonly deliveriesDue = this.registry.gauge(
    'sentinel_webhook_deliveries_due',
    'Webhook deliveries waiting to be sent or retried.',
  );
  private readonly scrapeSeconds = this.registry.gauge(
    'sentinel_metrics_refresh_seconds',
    'Time the last refresh of the database numbers took.',
  );
  private readonly cpu = this.registry.counter(
    'process_cpu_seconds_total',
    'CPU time used by the API process.',
  );
  private readonly memory = this.registry.gauge(
    'process_resident_memory_bytes',
    'Resident memory of the API process.',
  );
  private readonly started = this.registry.gauge(
    'process_start_time_seconds',
    'Start time of the API process.',
  );
  private readonly heap = this.registry.gauge(
    'nodejs_heap_used_bytes',
    'Used JavaScript heap.',
  );
  private readonly lag = this.registry.gauge(
    'nodejs_eventloop_lag_seconds',
    'Delay of the event loop.',
  );
  private readonly resources = this.registry.gauge(
    'nodejs_active_resources',
    'Handles and requests the process is waiting on.',
  );

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.eventLoop.enable();
  }

  onModuleDestroy(): void {
    this.eventLoop.disable();
  }

  enabled(): boolean {
    return this.config.get('METRICS_TOKEN') !== undefined;
  }

  observeRequest(
    method: string,
    route: string,
    status: number,
    seconds: number,
  ): void {
    this.requests.inc({ method, route, status: String(status) });
    this.durations.observe({ method, route }, seconds);
  }

  async render(): Promise<string> {
    await this.refresh();
    this.updateProcess();
    return this.registry.render();
  }

  private refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (Date.now() - this.refreshedAt < REFRESH_MS) return Promise.resolve();
    this.pending = this.collect().finally(() => {
      this.refreshedAt = Date.now();
      this.pending = undefined;
    });
    return this.pending;
  }

  private updateProcess(): void {
    const usage = process.cpuUsage();
    this.cpu.setTotal({}, (usage.user + usage.system) / 1e6);
    this.memory.set(process.memoryUsage().rss);
    this.heap.set(process.memoryUsage().heapUsed);
    this.started.set(Math.round(Date.now() / 1000 - process.uptime()));
    this.resources.set(process.getActiveResourcesInfo().length);
    const nanos = (value: number) => (Number.isFinite(value) ? value / 1e9 : 0);
    this.lag.clear();
    this.lag.set({ quantile: '0.5' }, nanos(this.eventLoop.percentile(50)));
    this.lag.set({ quantile: '0.99' }, nanos(this.eventLoop.percentile(99)));
    this.lag.set({ quantile: '1' }, nanos(this.eventLoop.max));
    this.eventLoop.reset();
    this.buildInfo.clear();
    this.buildInfo.set(
      {
        version: process.env.npm_package_version ?? 'unknown',
        node: process.version,
      },
      1,
    );
  }

  private async collect(): Promise<void> {
    const started = process.hrtime.bigint();
    const snapshot = await this.read();
    this.databaseUp.set(snapshot ? 1 : 0);
    this.scrapeSeconds.set(Number(process.hrtime.bigint() - started) / 1e9);
    this.monitors.clear();
    this.overdue.clear();
    this.checks.clear();
    this.incidents.clear();
    this.servers.clear();
    this.jobsDue.clear();
    this.jobsOldest.clear();
    this.deliveries.clear();
    this.deliveriesDue.clear();
    this.databaseSize.clear();
    this.organizations.clear();
    this.users.clear();
    this.pool.clear();
    if (!snapshot) return;

    const stats = this.db.poolStats();
    this.pool.set({ state: 'total' }, stats.total);
    this.pool.set({ state: 'idle' }, stats.idle);
    this.pool.set({ state: 'waiting' }, stats.waiting);
    this.databaseSize.set(snapshot.size);
    this.organizations.set(snapshot.organizations);
    this.users.set(snapshot.users);
    for (const status of MONITOR_STATUSES) {
      this.monitors.set(
        { status },
        snapshot.monitors.find((row) => row.key === status)?.n ?? 0,
      );
    }
    this.overdue.set(snapshot.overdue);
    this.checks.set(snapshot.checks);
    for (const status of INCIDENT_STATUSES) {
      for (const severity of INCIDENT_SEVERITIES) {
        const n =
          snapshot.incidents.find(
            (row) => row.key === status && row.second === severity,
          )?.n ?? 0;
        this.incidents.set({ status, severity }, n);
      }
    }
    for (const status of SERVER_STATUSES) {
      this.servers.set(
        { status },
        snapshot.servers.find((row) => row.key === status)?.n ?? 0,
      );
    }
    this.jobsDue.set(snapshot.jobsDue);
    this.jobsOldest.set(snapshot.jobsOldest);
    for (const status of DELIVERY_STATUSES) {
      this.deliveries.set(
        { status },
        snapshot.deliveries.find((row) => row.key === status)?.n ?? 0,
      );
    }
    this.deliveriesDue.set(snapshot.deliveriesDue);
  }

  private async read(): Promise<Snapshot | null> {
    try {
      const [
        totals,
        monitors,
        overdue,
        checks,
        incidents,
        servers,
        jobs,
        deliveries,
        deliveriesDue,
      ] = await Promise.all([
        this.db.row<{ size: string; organizations: number; users: number }>(
          `SELECT pg_database_size(current_database())::text AS size,
                  (SELECT count(*)::int FROM organizations) AS organizations,
                  (SELECT count(*)::int FROM users) AS users`,
        ),
        this.db.rows<{ key: string; n: number }>(
          `SELECT status AS key, count(*)::int AS n FROM monitors GROUP BY status`,
        ),
        this.db.row<{ n: number }>(
          `SELECT count(*)::int AS n FROM monitors
            WHERE NOT paused AND type <> 'heartbeat' AND next_check_at < now() - interval '1 minute'`,
        ),
        this.db.row<{ n: number }>(
          `SELECT count(*)::int AS n FROM check_results WHERE checked_at > now() - interval '1 minute'`,
        ),
        this.db.rows<{ key: string; second: string; n: number }>(
          `SELECT status AS key, severity AS second, count(*)::int AS n
             FROM incidents WHERE status <> 'resolved' GROUP BY status, severity`,
        ),
        this.db.rows<{ key: string; n: number }>(
          `SELECT CASE
                    WHEN last_seen_at IS NULL THEN 'pending'
                    WHEN now() - last_seen_at <= make_interval(secs => GREATEST(60, interval_sec * 4)) THEN 'online'
                    ELSE 'offline'
                  END AS key,
                  count(*)::int AS n
             FROM servers GROUP BY 1`,
        ),
        this.db.row<{ n: number; oldest: number }>(
          `SELECT count(*)::int AS n,
                  COALESCE(EXTRACT(EPOCH FROM now() - min(run_at)), 0)::float8 AS oldest
             FROM notification_jobs WHERE status = 'pending' AND run_at <= now()`,
        ),
        this.db.rows<{ key: string; n: number }>(
          `SELECT status AS key, count(*)::int AS n
             FROM webhook_deliveries WHERE created_at > now() - interval '1 hour' GROUP BY status`,
        ),
        this.db.row<{ n: number }>(
          `SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now()`,
        ),
      ]);
      return {
        size: Number(totals?.size ?? 0),
        organizations: totals?.organizations ?? 0,
        users: totals?.users ?? 0,
        monitors,
        overdue: overdue?.n ?? 0,
        checks: checks?.n ?? 0,
        incidents,
        servers,
        jobsDue: jobs?.n ?? 0,
        jobsOldest: Math.max(0, Number(jobs?.oldest ?? 0)),
        deliveries,
        deliveriesDue: deliveriesDue?.n ?? 0,
      };
    } catch {
      return null;
    }
  }
}
