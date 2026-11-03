import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClientMeta } from '../auth/auth.types';
import { RateLimiter } from '../common/rate-limiter';
import { randomToken, sha256 } from '../common/crypto';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { EventBus } from '../monitors/event-bus';
import { serverStatus, tokenActive } from './server.format';
import {
  enrollSchema,
  parseWith,
  reportSchema,
  type AgentInfo,
  type AgentSample,
} from './server.schema';
import type { EnrollmentTokenRow, ServerLatest } from './server.types';
import { MAX_SERVERS_PER_ORG } from './servers.service';

export const DEFAULT_INTERVAL_SEC = 15;
const FUTURE_SKEW_SEC = 120;
const MAX_WATCH = 50;
const OS_NAMES = ['linux', 'darwin'] as const;
const ARCH_ALIASES: Record<string, string> = {
  amd64: 'amd64',
  x86_64: 'amd64',
  x64: 'amd64',
  arm64: 'arm64',
  aarch64: 'arm64',
};

export interface EnrollResult {
  serverId: string;
  agentKey: string;
  name: string;
  intervalSec: number;
}

export interface ReportResult {
  ok: true;
  intervalSec: number;
  watch: { services: string[]; processes: string[] };
}

interface AgentServer {
  id: string;
  org_id: string;
  tags: string[];
  interval_sec: number;
  last_seen_at: Date | null;
  agent_version: string;
}

interface MetricRow {
  at: number;
  cpu: number;
  mem: number;
  swap: number;
  load1: number;
  disk: number;
  net_in: number;
  net_out: number;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function whole(value: number): number {
  return Math.round(clamp(value, 0, 1e15));
}

export function normalizeSamples(
  samples: AgentSample[],
  nowMs: number,
  retentionDays: number,
): { rows: MetricRow[]; latest: ServerLatest | null } {
  const oldest = nowMs - retentionDays * 86_400_000;
  const newest = nowMs + FUTURE_SKEW_SEC * 1000;
  const unique = new Map<number, AgentSample>();
  for (const sample of samples) {
    const ms = sample.at * 1000;
    if (ms < oldest || ms > newest) continue;
    unique.set(sample.at, sample);
  }
  const ordered = [...unique.values()].sort((a, b) => a.at - b.at);
  const rows = ordered.map((sample) => ({
    at: sample.at,
    cpu: clamp(sample.cpu, 0, 100),
    mem: clamp(sample.mem, 0, 100),
    swap: clamp(sample.swap, 0, 100),
    load1: clamp(sample.load1, 0, 100000),
    disk: clamp(sample.disk, 0, 100),
    net_in: clamp(sample.netIn, 0, 1e13),
    net_out: clamp(sample.netOut, 0, 1e13),
  }));
  const last = ordered[ordered.length - 1];
  if (!last) return { rows, latest: null };
  return {
    rows,
    latest: {
      at: new Date(last.at * 1000).toISOString(),
      cpu: clamp(last.cpu, 0, 100),
      mem: clamp(last.mem, 0, 100),
      memUsed: whole(last.memUsed),
      swap: clamp(last.swap, 0, 100),
      load1: clamp(last.load1, 0, 100000),
      load5: clamp(last.load5, 0, 100000),
      load15: clamp(last.load15, 0, 100000),
      disk: clamp(last.disk, 0, 100),
      netIn: clamp(last.netIn, 0, 1e13),
      netOut: clamp(last.netOut, 0, 1e13),
    },
  };
}

export function bearerKey(header: string | undefined): string | null {
  const match = /^Bearer\s+(isk_[A-Za-z0-9_-]{20,200})\s*$/.exec(header ?? '');
  return match ? match[1] : null;
}

export function normalizeTarget(
  os: string,
  arch: string,
): { os: string; arch: string } {
  const normalizedOs = os.trim().toLowerCase();
  const normalizedArch = ARCH_ALIASES[arch.trim().toLowerCase()];
  if (
    !(OS_NAMES as readonly string[]).includes(normalizedOs) ||
    !normalizedArch
  ) {
    throw new BadRequestException(
      'Use os=linux or darwin and arch=amd64 or arm64',
    );
  }
  return { os: normalizedOs, arch: normalizedArch };
}

@Injectable()
export class AgentService {
  private readonly limiter = new RateLimiter();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly bus: EventBus,
  ) {}

  async enroll(body: unknown, meta: ClientMeta): Promise<EnrollResult> {
    if (!this.limiter.attempt(`enroll:${meta.ip}`, 30, 600_000)) {
      throw new HttpException(
        'Too many enrollment attempts, try again in a few minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const input = parseWith(enrollSchema, body);
    const info = input.info;
    const agentKey = `isk_${randomToken(32)}`;
    const name = (input.name || info.hostname || 'New server').slice(0, 80);

    const result = await this.db.tx(async (tx) => {
      const token = await tx.row<EnrollmentTokenRow>(
        'SELECT * FROM enrollment_tokens WHERE token_hash = $1 FOR UPDATE',
        [sha256(input.token)],
      );
      if (!token || !tokenActive(token, new Date())) {
        throw new UnauthorizedException(
          'This enrollment token is invalid, expired or used up',
        );
      }

      const machineId = info.machineId || null;
      const known = machineId
        ? await tx.row(
            'SELECT 1 FROM servers WHERE org_id = $1 AND machine_id = $2',
            [token.org_id, machineId],
          )
        : undefined;
      if (!known) {
        const total = await tx.row<{ n: number }>(
          'SELECT count(*)::int AS n FROM servers WHERE org_id = $1',
          [token.org_id],
        );
        if ((total?.n ?? 0) >= MAX_SERVERS_PER_ORG) {
          throw new BadRequestException(
            `A workspace can have up to ${MAX_SERVERS_PER_ORG} servers`,
          );
        }
      }

      const row = await tx.row<{ id: string; name: string; inserted: boolean }>(
        `INSERT INTO servers (org_id, name, hostname, machine_id, agent_key_hash, enrollment_token_id, agent_version,
                              os, platform, kernel, arch, cpu_count, mem_total, swap_total, boot_time, ip, docker, systemd, interval_sec)
         VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9, $10, $11, $12::int, $13::bigint, $14::bigint,
                 CASE WHEN $15::bigint > 0 THEN to_timestamp($15::bigint) END, $16, $17::boolean, $18::boolean, $19::int)
         ON CONFLICT (org_id, machine_id) WHERE machine_id IS NOT NULL
         DO UPDATE SET agent_key_hash = EXCLUDED.agent_key_hash,
                       enrollment_token_id = EXCLUDED.enrollment_token_id,
                       agent_version = EXCLUDED.agent_version,
                       hostname = EXCLUDED.hostname, os = EXCLUDED.os, platform = EXCLUDED.platform,
                       kernel = EXCLUDED.kernel, arch = EXCLUDED.arch, cpu_count = EXCLUDED.cpu_count,
                       mem_total = EXCLUDED.mem_total, swap_total = EXCLUDED.swap_total,
                       boot_time = EXCLUDED.boot_time, ip = EXCLUDED.ip, docker = EXCLUDED.docker,
                       systemd = EXCLUDED.systemd, updated_at = now()
         RETURNING id, name, (xmax = 0) AS inserted`,
        [
          token.org_id,
          name,
          info.hostname,
          machineId,
          sha256(agentKey),
          token.id,
          info.agentVersion,
          info.os,
          info.platform,
          info.kernel,
          info.arch,
          info.cpuCount,
          whole(info.memTotal),
          whole(info.swapTotal),
          info.bootTime,
          info.ip,
          info.docker,
          info.systemd,
          DEFAULT_INTERVAL_SEC,
        ],
      );
      if (!row) throw new Error('The server was not saved');
      if (row.inserted)
        await tx.run(
          'UPDATE enrollment_tokens SET uses = uses + 1 WHERE id = $1',
          [token.id],
        );
      return { orgId: token.org_id, row };
    });

    this.bus.publish(result.orgId, {
      type: 'server',
      serverId: result.row.id,
      change: result.row.inserted ? 'created' : 'updated',
    });
    return {
      serverId: result.row.id,
      agentKey,
      name: result.row.name,
      intervalSec: DEFAULT_INTERVAL_SEC,
    };
  }

  async report(
    authorization: string | undefined,
    body: unknown,
    ip?: string,
  ): Promise<ReportResult> {
    const failures = `agent-bad-key:${ip ?? 'unknown'}`;
    if (this.limiter.blocked(failures, 60, 60_000)) {
      throw new HttpException(
        'Too many unknown agent keys. Wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const key = bearerKey(authorization);
    if (!key) {
      this.limiter.record(failures, 60_000);
      throw new UnauthorizedException('Send the agent key as a Bearer token');
    }
    const server = await this.db.row<AgentServer>(
      'SELECT id, org_id, tags, interval_sec, last_seen_at, agent_version FROM servers WHERE agent_key_hash = $1',
      [sha256(key)],
    );
    if (!server) {
      this.limiter.record(failures, 60_000);
      throw new UnauthorizedException(
        'Unknown agent key, enroll the agent again',
      );
    }
    if (!this.limiter.attempt(`report:${server.id}`, 40, 60_000)) {
      throw new HttpException(
        'Reports are arriving too fast',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const report = parseWith(reportSchema, body);
    const now = new Date();
    const { rows, latest } = normalizeSamples(
      report.samples,
      now.getTime(),
      this.config.get('METRIC_RETENTION_DAYS'),
    );
    const snapshot = report.snapshot;
    const info: AgentInfo | undefined = snapshot.info;

    const parts: Record<string, unknown> = {};
    if (snapshot.disks) parts.disks = snapshot.disks;
    if (snapshot.containers) parts.containers = snapshot.containers;
    if (snapshot.processes) parts.processes = snapshot.processes;
    if (snapshot.services) parts.services = snapshot.services;
    if (snapshot.failedServices) parts.failedServices = snapshot.failedServices;
    if (snapshot.watchedProcesses)
      parts.watchedProcesses = snapshot.watchedProcesses;

    const removed: string[] = [];
    if (info && !info.docker) removed.push('containers');
    if (info && !info.systemd) removed.push('services', 'failedServices');
    for (const dropped of removed) delete parts[dropped];

    await this.db.tx(async (tx) => {
      if (rows.length > 0) {
        await tx.run(
          `INSERT INTO server_metrics (server_id, ts, cpu, mem, swap, load1, disk, net_in, net_out)
           SELECT $1::uuid, to_timestamp(s.at), s.cpu, s.mem, s.swap, s.load1, s.disk, s.net_in, s.net_out
             FROM jsonb_to_recordset($2::jsonb)
                  AS s(at bigint, cpu real, mem real, swap real, load1 real, disk real, net_in real, net_out real)
           ON CONFLICT DO NOTHING`,
          [server.id, JSON.stringify(rows)],
        );
      }
      await tx.run(
        `UPDATE servers
            SET last_seen_at = now(),
                agent_version = CASE WHEN $2::text <> '' THEN $2::text ELSE agent_version END,
                latest = CASE
                  WHEN $3::jsonb IS NULL THEN latest
                  WHEN COALESCE((latest->>'at')::timestamptz, '-infinity'::timestamptz) <= ($3::jsonb->>'at')::timestamptz
                    THEN $3::jsonb
                  ELSE latest
                END,
                snapshot = (snapshot - $4::text[]) || $5::jsonb,
                docker = docker OR $6::boolean
          WHERE id = $1`,
        [
          server.id,
          report.agentVersion || (info?.agentVersion ?? ''),
          latest ? JSON.stringify(latest) : null,
          removed,
          JSON.stringify(parts),
          snapshot.containers !== undefined,
        ],
      );
      if (info) {
        await tx.run(
          `UPDATE servers
              SET hostname = $2, os = $3, platform = $4, kernel = $5, arch = $6, cpu_count = $7::int,
                  mem_total = $8::bigint, swap_total = $9::bigint,
                  boot_time = CASE WHEN $10::bigint > 0 THEN to_timestamp($10::bigint) END,
                  ip = $11, docker = $12::boolean, systemd = $13::boolean, updated_at = now()
            WHERE id = $1`,
          [
            server.id,
            info.hostname,
            info.os,
            info.platform,
            info.kernel,
            info.arch,
            info.cpuCount,
            whole(info.memTotal),
            whole(info.swapTotal),
            info.bootTime,
            info.ip,
            info.docker,
            info.systemd,
          ],
        );
      }
    });

    const before = serverStatus(server.last_seen_at, server.interval_sec, now);
    if (before !== 'online') {
      this.bus.publish(server.org_id, {
        type: 'server',
        serverId: server.id,
        change: 'status',
      });
    }

    return {
      ok: true,
      intervalSec: server.interval_sec,
      watch: await this.watchLists(server),
    };
  }

  installScript(): string {
    const file = resolve(this.agentDir(), 'install.sh');
    if (!existsSync(file)) {
      throw new NotFoundException(
        'install.sh was not found in the agent folder',
      );
    }
    const apiUrl = this.config.get('PUBLIC_API_URL').replace(/\/+$/, '');
    return readFileSync(file, 'utf8').split('__API_URL__').join(apiUrl);
  }

  binaryPath(osName: string, archName: string): { path: string; file: string } {
    const target = normalizeTarget(osName, archName);
    const file = `infra-sentinel-agent-${target.os}-${target.arch}`;
    const path = resolve(this.agentDir(), 'dist', file);
    if (!existsSync(path)) {
      throw new NotFoundException(
        `The ${target.os}/${target.arch} agent is not built yet. On the API host run: bash scripts/agent-build.sh`,
      );
    }
    return { path, file };
  }

  private agentDir(): string {
    return resolve(process.cwd(), this.config.get('AGENT_DIR'));
  }

  private async watchLists(
    server: AgentServer,
  ): Promise<{ services: string[]; processes: string[] }> {
    const rules = await this.db.rows<{ metric: string; target: string }>(
      `SELECT DISTINCT metric, target
         FROM server_rules
        WHERE org_id = $1 AND enabled AND metric IN ('service', 'process')
          AND target <> '' AND target <> '*'
          AND (scope_all OR $2::uuid = ANY(server_ids) OR tags && $3::text[])
        LIMIT 200`,
      [server.org_id, server.id, server.tags ?? []],
    );
    const services = rules
      .filter((rule) => rule.metric === 'service')
      .map((rule) => rule.target);
    const processes = rules
      .filter((rule) => rule.metric === 'process')
      .map((rule) => rule.target);
    return {
      services: services.slice(0, MAX_WATCH),
      processes: processes.slice(0, MAX_WATCH),
    };
  }
}
