import { z } from 'zod';
import { SEVERITIES } from '../alerting/alert.types';
import { parseWith } from '../monitors/monitor.schema';
import {
  ANOMALY_METRICS,
  NAMED_METRICS,
  PERCENT_METRICS,
  RULE_MODES,
  SENSITIVITIES,
  SERVER_METRICS,
  type ServerMetric,
} from './server.types';

export { parseWith };

const name = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(80, 'Use at most 80 characters');
const uuid = z.string().uuid('Invalid id');
const tag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,23}$/,
    'Tags use letters, numbers, dashes and underscores',
  );

const unique = <T>(items: T[]): T[] => [...new Set(items)];
const text = (max: number) => z.string().max(max).default('');
const count = z.number().finite().min(0).max(1e15).default(0);
const nullableCount = z
  .number()
  .finite()
  .min(0)
  .max(1e15)
  .nullable()
  .optional()
  .default(null);

const infoSchema = z.object({
  hostname: text(253),
  os: text(30),
  platform: text(120),
  kernel: text(120),
  arch: text(30),
  cpuCount: z.number().int().min(0).max(4096).default(0),
  memTotal: count,
  swapTotal: count,
  bootTime: z.number().int().min(0).max(4_102_444_800).default(0),
  ip: text(64),
  machineId: text(100),
  docker: z.boolean().default(false),
  systemd: z.boolean().default(false),
  agentVersion: text(40),
});

export type AgentInfo = z.infer<typeof infoSchema>;

export const enrollSchema = z.object({
  token: z.string().trim().min(8).max(200),
  name: z.string().trim().max(80).optional(),
  info: infoSchema,
});

const sampleSchema = z.object({
  at: z.number().int().min(0).max(4_102_444_800),
  cpu: z.number().finite().default(0),
  mem: z.number().finite().default(0),
  memUsed: count,
  swap: z.number().finite().default(0),
  load1: z.number().finite().min(0).max(100000).default(0),
  load5: z.number().finite().min(0).max(100000).default(0),
  load15: z.number().finite().min(0).max(100000).default(0),
  disk: z.number().finite().default(0),
  netIn: count,
  netOut: count,
});

export type AgentSample = z.infer<typeof sampleSchema>;

const diskSchema = z.object({
  mount: z.string().max(200),
  device: text(200),
  fs: text(30),
  total: count,
  used: count,
  pct: z.number().finite().default(0),
});

const containerSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(200),
  image: text(200),
  state: text(20),
  health: text(20),
  status: text(100),
  createdAt: z.number().finite().default(0),
  cpu: nullableCount,
  memUsed: nullableCount,
  memLimit: nullableCount,
  netIn: nullableCount,
  netOut: nullableCount,
});

const processSchema = z.object({
  pid: z.number().int().min(0).max(1e9),
  name: z.string().max(100),
  cmd: text(200),
  user: text(64),
  cpu: z.number().finite().min(0).max(100000).default(0),
  mem: z.number().finite().min(0).max(100).default(0),
  memBytes: count,
});

const serviceSchema = z.object({
  name: z.string().max(100),
  state: z.string().max(30),
});

export const reportSchema = z.object({
  agentVersion: text(40),
  samples: z.array(sampleSchema).max(120).default([]),
  snapshot: z
    .object({
      info: infoSchema.optional(),
      disks: z.array(diskSchema).max(16).optional(),
      containers: z.array(containerSchema).max(150).optional(),
      processes: z.array(processSchema).max(30).optional(),
      services: z.array(serviceSchema).max(60).optional(),
      failedServices: z.array(z.string().max(100)).max(50).optional(),
      watchedProcesses: z
        .record(z.string().max(100), z.number().int().min(0).max(100000))
        .optional(),
    })
    .default({}),
});

export type AgentReport = z.infer<typeof reportSchema>;

export const serverPatchSchema = z
  .object({
    name: name.optional(),
    tags: z.array(tag).max(20).optional(),
  })
  .strict();

export const linkMonitorsSchema = z
  .object({ monitorIds: z.array(uuid).max(100) })
  .strict()
  .transform((value) => ({ monitorIds: unique(value.monitorIds) }));

export const tokenCreateSchema = z
  .object({
    name,
    expiresInDays: z.coerce.number().int().min(1).max(365).default(7),
    maxUses: z.preprocess(
      (value) => (value === null || value === '' ? undefined : value),
      z.coerce.number().int().min(1).max(10000).optional(),
    ),
  })
  .strict();

const scopeSchema = z
  .object({
    all: z.boolean().default(false),
    serverIds: z.array(uuid).max(200).default([]),
    tags: z.array(tag).max(20).default([]),
  })
  .superRefine((value, context) => {
    if (!value.all && value.serverIds.length === 0 && value.tags.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Choose all servers, or at least one server or tag',
      });
    }
  })
  .transform((value) =>
    value.all
      ? { all: true, serverIds: [] as string[], tags: [] as string[] }
      : value,
  );

const DEFAULT_THRESHOLD: Partial<Record<ServerMetric, number>> = {
  offline: 90,
  cpu: 90,
  memory: 90,
  swap: 80,
  disk: 90,
  load: 2,
};

const NAME_PATTERNS: Partial<Record<ServerMetric, RegExp>> = {
  container: /^[A-Za-z0-9][A-Za-z0-9_.*-]{0,99}$|^\*$/,
  service: /^[A-Za-z0-9:_.@-]{1,100}$|^\*$/,
  process: /^[A-Za-z0-9_.@:+/-]{1,100}$/,
};

const NAME_HINTS: Partial<Record<ServerMetric, string>> = {
  container:
    'Enter a container name, you can use * as a wildcard, for example api-*',
  service: 'Enter a service name such as nginx, or * for any failed service',
  process: 'Enter a process name such as redis-server',
};

const emptyToUndefined = (value: unknown) =>
  value === null || value === '' ? undefined : value;

const ruleShape = {
  name,
  enabled: z.boolean().default(true),
  metric: z.enum(SERVER_METRICS),
  mode: z.enum(RULE_MODES).default('threshold'),
  threshold: z.preprocess(
    emptyToUndefined,
    z.coerce.number().finite().optional(),
  ),
  sensitivity: z.enum(SENSITIVITIES).default('medium'),
  target: z.string().trim().max(100).default(''),
  severity: z.enum(SEVERITIES).default('warning'),
  forSec: z.coerce.number().int().min(0).max(86_400).default(300),
  scope: scopeSchema,
  channelIds: z.array(uuid).max(20).default([]),
  policyId: uuid.nullable().default(null),
  notifyRecovery: z.boolean().default(true),
};

export const serverRuleSchema = z
  .object(ruleShape)
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string, path: string) =>
      context.addIssue({ code: 'custom', message, path: [path] });
    if (value.channelIds.length === 0 && value.policyId === null) {
      issue(
        'Choose at least one channel or an escalation policy',
        'channelIds',
      );
    }
    if (value.mode === 'anomaly') {
      if (!ANOMALY_METRICS.includes(value.metric)) {
        issue(
          'Anomaly detection works for CPU, memory, load and network traffic',
          'metric',
        );
      }
      return;
    }
    if (value.metric === 'net_in' || value.metric === 'net_out') {
      issue(
        'Network traffic can only be watched with anomaly detection',
        'metric',
      );
      return;
    }
    if (NAMED_METRICS.includes(value.metric)) {
      const pattern = NAME_PATTERNS[value.metric];
      if (!value.target || (pattern && !pattern.test(value.target))) {
        issue(NAME_HINTS[value.metric] ?? 'Enter a name', 'target');
      }
      return;
    }
    const threshold = value.threshold ?? DEFAULT_THRESHOLD[value.metric];
    if (threshold === undefined) return;
    if (
      PERCENT_METRICS.includes(value.metric) &&
      (threshold < 1 || threshold > 100)
    ) {
      issue('Use a percentage between 1 and 100', 'threshold');
    }
    if (value.metric === 'load' && (threshold < 0.1 || threshold > 100)) {
      issue('Use a load per core between 0.1 and 100', 'threshold');
    }
    if (value.metric === 'offline' && (threshold < 30 || threshold > 86_400)) {
      issue('Use between 30 seconds and 24 hours', 'threshold');
    }
  })
  .transform((value) => {
    const named = NAMED_METRICS.includes(value.metric);
    const anomaly = value.mode === 'anomaly';
    return {
      ...value,
      channelIds: unique(value.channelIds),
      threshold:
        anomaly || named
          ? null
          : (value.threshold ?? DEFAULT_THRESHOLD[value.metric] ?? null),
      target: !anomaly && named ? value.target : '',
    };
  });

export type ServerRuleInput = z.infer<typeof serverRuleSchema>;

export const serverRulePatchSchema = z
  .object({
    name: ruleShape.name.optional(),
    enabled: z.boolean().optional(),
    metric: z.enum(SERVER_METRICS).optional(),
    mode: z.enum(RULE_MODES).optional(),
    threshold: z.unknown().optional(),
    sensitivity: z.enum(SENSITIVITIES).optional(),
    target: z.string().trim().max(100).optional(),
    severity: z.enum(SEVERITIES).optional(),
    forSec: z.coerce.number().int().min(0).max(86_400).optional(),
    scope: z.unknown().optional(),
    channelIds: z.array(uuid).max(20).optional(),
    policyId: uuid.nullable().optional(),
    notifyRecovery: z.boolean().optional(),
  })
  .strict();
