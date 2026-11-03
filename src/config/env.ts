import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const optionalText = z
  .string()
  .optional()
  .transform((value) => value || undefined);

export const DEV_APP_SECRET = 'infra-sentinel-development-secret-change-me';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://sentinel:sentinel@localhost:5432/infra_sentinel'),
  MIGRATE_ON_BOOT: flag('true'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: flag('false'),
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: flag('false'),
  SMTP_USER: optionalText,
  SMTP_PASS: optionalText,
  MAIL_FROM: z
    .string()
    .min(1)
    .default('Infra Sentinel <noreply@sentinel.local>'),
  SCHEDULER_ENABLED: flag('true'),
  SCHEDULER_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(20),
  RESULT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  BLOCK_PRIVATE_TARGETS: flag('false'),
  METRIC_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  AGENT_DIR: z.string().min(1).default('../infra-sentinel-agent'),
  APP_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters')
    .default(DEV_APP_SECRET),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
  NOTIFICATION_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30),
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  API_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(10)
    .max(100000)
    .default(600),
  SSO_ALLOW_HTTP: flag('false'),
  METRICS_TOKEN: optionalText.refine(
    (value) => value === undefined || value.length >= 16,
    'must be at least 16 characters',
  ),
  LOG_FORMAT: z.enum(['text', 'json']).default('text'),
  SIGNUPS: z.enum(['open', 'invite', 'closed']).default('open'),
});

export type Env = z.infer<typeof schema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.APP_SECRET === DEV_APP_SECRET
  ) {
    throw new Error(
      'Invalid environment configuration:\n  - APP_SECRET: set a long random value in production',
    );
  }
  return parsed.data;
}

export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.endsWith(quote) &&
      value.length > 1
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    values[key] = value;
  }
  return values;
}

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
  file: string = resolve(process.cwd(), '.env'),
): Env {
  const fromFile = existsSync(file)
    ? parseDotenv(readFileSync(file, 'utf8'))
    : {};
  return validateEnv({ ...fromFile, ...source });
}
