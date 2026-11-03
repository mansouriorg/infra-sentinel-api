import { isIP } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { MonitorType } from './monitor.types';

export const MASK = '********';

const optionalNumber = (min: number, max: number) =>
  z.preprocess(
    (value) => (value === null || value === '' ? undefined : value),
    z.coerce.number().int().min(min).max(max).optional(),
  );

const host = z
  .string()
  .trim()
  .min(1, 'Enter a host name or IP address')
  .max(253)
  .regex(
    /^[A-Za-z0-9_:][A-Za-z0-9_.:-]*$/,
    'Enter a host name or IP address, without http:// or a path',
  );

const port = z.coerce.number().int().min(1).max(65535);

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .url('Enter a full address such as https://example.com')
  .refine(
    (value) => /^https?:\/\//i.test(value),
    'Use an http:// or https:// address',
  );

const headers = z
  .record(z.string(), z.string())
  .default({})
  .superRefine((value, context) => {
    const entries = Object.entries(value);
    if (entries.length > 20) {
      context.addIssue({ code: 'custom', message: 'Use at most 20 headers' });
    }
    for (const [name, content] of entries) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
        context.addIssue({
          code: 'custom',
          message: `Invalid header name: ${name}`,
        });
      }
      if (/[\r\n]/.test(content) || content.length > 2000) {
        context.addIssue({
          code: 'custom',
          message: `Invalid value for header ${name}`,
        });
      }
    }
  });

const httpFields = {
  url: httpUrl,
  method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
  headers,
  body: z.string().max(10_000).optional(),
  expectedStatus: z
    .string()
    .trim()
    .regex(
      /^\d{3}(-\d{3})?(\s*,\s*\d{3}(-\d{3})?)*$/,
      'Use codes like 200, 200-299 or 200,301',
    )
    .default('200-299'),
  followRedirects: z.boolean().default(true),
  ignoreTls: z.boolean().default(false),
  jsonPath: z.string().trim().max(200).optional(),
  jsonEquals: z.string().max(500).optional(),
  degradedMs: optionalNumber(1, 600_000),
};

const httpConfig = z.object(httpFields);

const keywordConfig = z.object({
  ...httpFields,
  keyword: z.string().min(1, 'Enter the text to look for').max(200),
  keywordMode: z.enum(['present', 'absent']).default('present'),
  caseSensitive: z.boolean().default(false),
});

const tcpConfig = z.object({
  host,
  port,
  degradedMs: optionalNumber(1, 600_000),
});
const pingConfig = z.object({ host, degradedMs: optionalNumber(1, 600_000) });

const dnsConfig = z.object({
  host,
  recordType: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT']).default('A'),
  expected: z.string().trim().max(200).optional(),
  resolver: z
    .string()
    .trim()
    .refine(
      (value) => isIP(value) !== 0,
      'Use an IP address such as 1.1.1.1, without a port',
    )
    .optional(),
  degradedMs: optionalNumber(1, 600_000),
});

const sslConfig = z.object({
  host,
  port: port.default(443),
  warnDays: z.coerce.number().int().min(1).max(90).default(14),
  allowUntrusted: z.boolean().default(false),
});

const heartbeatConfig = z.object({
  graceSec: z.coerce.number().int().min(0).max(86_400).default(60),
});

export const CONFIG_SCHEMAS = {
  http: httpConfig,
  keyword: keywordConfig,
  tcp: tcpConfig,
  ping: pingConfig,
  dns: dnsConfig,
  ssl: sslConfig,
  heartbeat: heartbeatConfig,
} as const;

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,23}$/,
    'Tags use letters, numbers, dashes and underscores',
  );

const name = z.string().trim().min(1, 'Give the monitor a name').max(80);
const intervalSec = z.coerce.number().int().min(20).max(86_400);
const timeoutMs = z.coerce.number().int().min(1000).max(60_000);
const failureThreshold = z.coerce.number().int().min(1).max(10);

const common = {
  name,
  intervalSec: intervalSec.default(60),
  timeoutMs: timeoutMs.default(10_000),
  failureThreshold: failureThreshold.default(2),
  tags: z.array(tag).max(10).default([]),
};

export const createSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('http'), ...common, config: httpConfig }),
  z.object({ type: z.literal('keyword'), ...common, config: keywordConfig }),
  z.object({ type: z.literal('tcp'), ...common, config: tcpConfig }),
  z.object({ type: z.literal('ping'), ...common, config: pingConfig }),
  z.object({ type: z.literal('dns'), ...common, config: dnsConfig }),
  z.object({ type: z.literal('ssl'), ...common, config: sslConfig }),
  z.object({
    type: z.literal('heartbeat'),
    ...common,
    config: heartbeatConfig,
  }),
]);

export const updateSchema = z
  .object({
    name: name.optional(),
    intervalSec: intervalSec.optional(),
    timeoutMs: timeoutMs.optional(),
    failureThreshold: failureThreshold.optional(),
    tags: z.array(tag).max(10).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CreateMonitorInput = z.infer<typeof createSchema>;
export type UpdateMonitorInput = z.infer<typeof updateSchema>;

export interface HttpConfig {
  url: string;
  method: 'GET' | 'HEAD' | 'POST';
  headers: Record<string, string>;
  body?: string;
  expectedStatus: string;
  followRedirects: boolean;
  ignoreTls: boolean;
  jsonPath?: string;
  jsonEquals?: string;
  degradedMs?: number;
  keyword?: string;
  keywordMode?: 'present' | 'absent';
  caseSensitive?: boolean;
}

export interface TcpConfig {
  host: string;
  port: number;
  degradedMs?: number;
}

export interface PingConfig {
  host: string;
  degradedMs?: number;
}

export interface DnsConfig {
  host: string;
  recordType: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'TXT';
  expected?: string;
  resolver?: string;
  degradedMs?: number;
}

export interface SslConfig {
  host: string;
  port: number;
  warnDays: number;
  allowUntrusted: boolean;
}

export interface HeartbeatConfig {
  graceSec: number;
}

export function parseWith<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const messages = result.error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw new BadRequestException(messages.join('. '));
}

export function parseConfig(
  type: MonitorType,
  input: unknown,
): Record<string, any> {
  return parseWith(CONFIG_SCHEMAS[type], input) as Record<string, any>;
}

export function assertLimits(
  type: MonitorType,
  intervalSeconds: number,
  timeoutMilliseconds: number,
): void {
  if (type === 'ssl' && intervalSeconds < 300) {
    throw new BadRequestException(
      'Certificate checks run at most every 5 minutes',
    );
  }
  if (type === 'heartbeat' && intervalSeconds < 30) {
    throw new BadRequestException(
      'Heartbeat monitors need an interval of at least 30 seconds',
    );
  }
  if (type !== 'heartbeat' && timeoutMilliseconds > intervalSeconds * 1000) {
    throw new BadRequestException(
      'The timeout must be shorter than the check interval',
    );
  }
}

export function maskConfig(config: Record<string, any>): Record<string, any> {
  const headers = config.headers;
  if (!headers || typeof headers !== 'object') return config;
  const masked: Record<string, string> = {};
  for (const key of Object.keys(headers)) masked[key] = MASK;
  return { ...config, headers: masked };
}

export const REENTER_SECRETS =
  'Re-enter the secret values when you change the address';

export function sameDestination(a: unknown, b: unknown): boolean {
  const text = (value: unknown) =>
    typeof value === 'string' ? value.trim() : '';
  const left = text(a);
  const right = text(b);
  if (left === right) return true;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function restoreMasked(
  incoming: Record<string, unknown>,
  existing: Record<string, any>,
): Record<string, unknown> {
  const headers = incoming.headers;
  if (!headers || typeof headers !== 'object') return incoming;
  const asksForStored = Object.values(headers as Record<string, unknown>).some(
    (value) => value === MASK,
  );
  if (asksForStored && !sameDestination(incoming.url, existing.url)) {
    throw new BadRequestException(REENTER_SECRETS);
  }
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    restored[key] = value === MASK ? (existing.headers?.[key] ?? '') : value;
  }
  return { ...incoming, headers: restored };
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function describeTarget(
  type: MonitorType,
  config: Record<string, any>,
  intervalSec: number,
): string {
  switch (type) {
    case 'http':
    case 'keyword':
      return String(config.url ?? '');
    case 'tcp':
      return `${config.host}:${config.port}`;
    case 'ping':
      return String(config.host ?? '');
    case 'dns':
      return `${config.host} (${config.recordType ?? 'A'} record)`;
    case 'ssl':
      return `${config.host}:${config.port ?? 443}`;
    case 'heartbeat':
      return `Expects a ping every ${formatInterval(intervalSec)}`;
  }
}
