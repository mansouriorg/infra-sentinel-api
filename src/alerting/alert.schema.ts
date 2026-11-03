import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import {
  MASK,
  REENTER_SECRETS,
  parseWith,
  sameDestination,
} from '../monitors/monitor.schema';
import { maxWindowSeconds } from './alert.scope';
import type { ChannelType, EscalationStep } from './alert.types';
import { CHANNEL_TYPES, REPEATS, SEVERITIES, TRIGGERS } from './alert.types';

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

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .url('Enter a full address such as https://example.com')
  .refine(
    (value) => /^https?:\/\//i.test(value),
    'Use an http:// or https:// address',
  );

const baseUrl = httpUrl.transform((value) => value.replace(/\/+$/, ''));

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (value === null || value === '' ? undefined : value),
    z.string().trim().max(max).optional(),
  );

const emailConfig = z.object({
  recipients: z
    .array(z.string().trim().toLowerCase().email('Enter valid email addresses'))
    .min(1, 'Add at least one email address')
    .max(10, 'Use at most 10 recipients'),
});

const slackConfig = z.object({ webhookUrl: httpUrl });
const discordConfig = z.object({ webhookUrl: httpUrl });

const telegramConfig = z.object({
  botToken: z
    .string()
    .trim()
    .min(10, 'Enter the bot token from BotFather')
    .max(200),
  chatId: z.preprocess(
    (value) => (typeof value === 'number' ? String(value) : value),
    z.string().trim().min(1, 'Enter the chat id').max(100),
  ),
  apiBaseUrl: z.preprocess(
    (value) => (value === '' ? undefined : value),
    baseUrl.optional(),
  ),
});

const ntfyConfig = z.object({
  serverUrl: z.preprocess(
    (value) =>
      value === '' || value === undefined ? 'https://ntfy.sh' : value,
    baseUrl,
  ),
  topic: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9_-]{1,64}$/,
      'A topic uses letters, numbers, dashes and underscores',
    ),
  token: optionalText(200),
});

const gotifyConfig = z.object({
  serverUrl: baseUrl,
  appToken: z.string().trim().min(1, 'Enter the application token').max(200),
});

const webhookHeaders = z
  .record(z.string(), z.string())
  .default({})
  .superRefine((value, context) => {
    const entries = Object.entries(value);
    if (entries.length > 10)
      context.addIssue({ code: 'custom', message: 'Use at most 10 headers' });
    for (const [key, content] of entries) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) {
        context.addIssue({
          code: 'custom',
          message: `Invalid header name: ${key}`,
        });
      }
      if (/[\r\n]/.test(content) || content.length > 1000) {
        context.addIssue({
          code: 'custom',
          message: `Invalid value for header ${key}`,
        });
      }
    }
  });

const webhookConfig = z.object({
  url: httpUrl,
  headers: webhookHeaders,
  secret: optionalText(200),
});

export const CHANNEL_CONFIG: Record<ChannelType, z.ZodTypeAny> = {
  email: emailConfig,
  slack: slackConfig,
  discord: discordConfig,
  telegram: telegramConfig,
  ntfy: ntfyConfig,
  gotify: gotifyConfig,
  webhook: webhookConfig,
};

const SECRET_FIELDS: Record<ChannelType, string[]> = {
  email: [],
  slack: ['webhookUrl'],
  discord: ['webhookUrl'],
  telegram: ['botToken'],
  ntfy: ['topic', 'token'],
  gotify: ['appToken'],
  webhook: ['url', 'secret'],
};

export function parseChannelConfig(
  type: ChannelType,
  input: unknown,
): Record<string, any> {
  return parseWith(CHANNEL_CONFIG[type], input) as Record<string, any>;
}

export function maskChannelConfig(
  type: ChannelType,
  config: Record<string, any>,
): Record<string, any> {
  const masked: Record<string, any> = { ...config };
  for (const field of SECRET_FIELDS[type]) {
    if (
      masked[field] !== undefined &&
      masked[field] !== null &&
      masked[field] !== ''
    )
      masked[field] = MASK;
  }
  if (masked.headers && typeof masked.headers === 'object') {
    masked.headers = Object.fromEntries(
      Object.keys(masked.headers).map((key) => [key, MASK]),
    );
  }
  return masked;
}

const DESTINATION_FIELDS: Record<ChannelType, string[]> = {
  email: [],
  slack: [],
  discord: [],
  telegram: ['apiBaseUrl'],
  ntfy: ['serverUrl'],
  gotify: ['serverUrl'],
  webhook: ['url'],
};

export function restoreChannelConfig(
  type: ChannelType,
  incoming: Record<string, unknown>,
  existing: Record<string, any>,
): Record<string, unknown> {
  const headerValues =
    incoming.headers && typeof incoming.headers === 'object'
      ? Object.values(incoming.headers as Record<string, unknown>)
      : [];
  const asksForStored =
    SECRET_FIELDS[type].some((field) => incoming[field] === MASK) ||
    headerValues.includes(MASK);
  const moved = DESTINATION_FIELDS[type].some(
    (field) =>
      incoming[field] !== MASK &&
      !sameDestination(incoming[field], existing[field]),
  );
  if (asksForStored && moved) {
    throw new BadRequestException(REENTER_SECRETS);
  }
  const restored: Record<string, unknown> = { ...incoming };
  for (const field of SECRET_FIELDS[type]) {
    if (restored[field] === MASK) restored[field] = existing[field];
  }
  if (restored.headers && typeof restored.headers === 'object') {
    restored.headers = Object.fromEntries(
      Object.entries(restored.headers as Record<string, unknown>).map(
        ([key, value]) => [
          key,
          value === MASK ? (existing.headers?.[key] ?? '') : value,
        ],
      ),
    );
  }
  return restored;
}

export function describeChannel(
  type: ChannelType,
  config: Record<string, any>,
): string {
  const host = (value: unknown) => {
    try {
      return new URL(String(value)).host;
    } catch {
      return '';
    }
  };
  switch (type) {
    case 'email':
      return (config.recipients as string[] | undefined)?.join(', ') ?? '';
    case 'slack':
      return 'Slack incoming webhook';
    case 'discord':
      return 'Discord webhook';
    case 'telegram':
      return `Chat ${config.chatId ?? ''}`.trim();
    case 'ntfy':
      return `ntfy at ${host(config.serverUrl)}`;
    case 'gotify':
      return `Gotify at ${host(config.serverUrl)}`;
    case 'webhook':
      return `Webhook to ${host(config.url)}`;
  }
}

export const channelCreateSchema = z
  .object({
    name,
    type: z.enum(CHANNEL_TYPES),
    config: z.record(z.string(), z.unknown()),
    enabled: z.boolean().default(true),
  })
  .strict();

export const channelUpdateSchema = z
  .object({
    name: name.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const channelTestSchema = z.object({
  channelId: uuid.optional(),
  type: z.enum(CHANNEL_TYPES).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const scopeSchema = z
  .object({
    all: z.boolean().default(false),
    monitorIds: z.array(uuid).max(200).default([]),
    tags: z.array(tag).max(20).default([]),
  })
  .superRefine((value, context) => {
    if (
      !value.all &&
      value.monitorIds.length === 0 &&
      value.tags.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Choose all monitors, or at least one monitor or tag',
      });
    }
  })
  .transform((value) =>
    value.all
      ? { all: true, monitorIds: [] as string[], tags: [] as string[] }
      : value,
  );

const unique = <T>(items: T[]): T[] => [...new Set(items)];

const ruleShape = {
  name,
  enabled: z.boolean().default(true),
  trigger: z.enum(TRIGGERS).default('down'),
  severity: z.enum(SEVERITIES).default('critical'),
  forSec: z.coerce.number().int().min(0).max(86_400).default(0),
  scope: scopeSchema,
  channelIds: z.array(uuid).max(20).default([]),
  policyId: uuid.nullable().default(null),
  notifyRecovery: z.boolean().default(true),
};

export const ruleSchema = z
  .object(ruleShape)
  .strict()
  .superRefine((value, context) => {
    if (value.channelIds.length === 0 && value.policyId === null) {
      context.addIssue({
        code: 'custom',
        message: 'Choose at least one channel or an escalation policy',
      });
    }
  })
  .transform((value) => ({ ...value, channelIds: unique(value.channelIds) }));

export const rulePatchSchema = z
  .object({
    name: ruleShape.name.optional(),
    enabled: z.boolean().optional(),
    trigger: z.enum(TRIGGERS).optional(),
    severity: z.enum(SEVERITIES).optional(),
    forSec: z.coerce.number().int().min(0).max(86_400).optional(),
    scope: z.unknown().optional(),
    channelIds: z.array(uuid).max(20).optional(),
    policyId: uuid.nullable().optional(),
    notifyRecovery: z.boolean().optional(),
  })
  .strict();

const stepSchema = z.object({
  afterSec: z.coerce.number().int().min(0).max(172_800),
  channelIds: z.array(uuid).max(10).default([]),
  scheduleId: uuid.nullable().default(null),
});

export const policySchema = z
  .object({
    name,
    steps: z
      .array(stepSchema)
      .min(1, 'Add at least one step')
      .max(6, 'Use at most 6 steps'),
  })
  .strict()
  .superRefine((value, context) => {
    value.steps.forEach((step, index) => {
      if (step.channelIds.length === 0 && step.scheduleId === null) {
        context.addIssue({
          code: 'custom',
          message: `Step ${index + 1} needs a channel or an on-call schedule`,
        });
      }
    });
  })
  .transform((value) => ({
    name: value.name,
    steps: [...value.steps]
      .sort((a, b) => a.afterSec - b.afterSec)
      .map(
        (step): EscalationStep => ({
          ...step,
          channelIds: unique(step.channelIds),
        }),
      ),
  }));

export const policyPatchSchema = z
  .object({ name: name.optional(), steps: z.array(z.unknown()).optional() })
  .strict();

const dateInput = z.preprocess(
  (value) =>
    value === undefined || value === null || value === '' ? undefined : value,
  z.coerce.date(),
);

export const scheduleSchema = z
  .object({
    name,
    members: z.array(uuid).min(1, 'Add at least one person').max(30),
    anchorAt: z.preprocess(
      (value) =>
        value === undefined || value === null || value === ''
          ? new Date().toISOString()
          : value,
      z.coerce.date(),
    ),
    periodSec: z.coerce
      .number()
      .int()
      .min(3600, 'A shift lasts at least one hour')
      .max(31_536_000)
      .default(604_800),
  })
  .strict()
  .transform((value) => ({ ...value, members: unique(value.members) }));

export const schedulePatchSchema = z
  .object({
    name: name.optional(),
    members: z.array(uuid).min(1).max(30).optional(),
    anchorAt: z.unknown().optional(),
    periodSec: z.coerce.number().int().min(3600).max(31_536_000).optional(),
  })
  .strict();

const MAX_SILENCE_MS = 90 * 86_400_000;

export const silenceSchema = z
  .object({
    name,
    scope: scopeSchema,
    startsAt: z.preprocess(
      (value) =>
        value === undefined || value === null || value === ''
          ? new Date().toISOString()
          : value,
      z.coerce.date(),
    ),
    endsAt: dateInput,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endsAt.getTime() <= value.startsAt.getTime()) {
      context.addIssue({
        code: 'custom',
        message: 'The end must be after the start',
      });
    } else if (
      value.endsAt.getTime() - value.startsAt.getTime() >
      MAX_SILENCE_MS
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A silence can last at most 90 days',
      });
    }
  });

export const maintenanceSchema = z
  .object({
    name,
    scope: scopeSchema,
    startsAt: dateInput,
    durationSec: z.coerce
      .number()
      .int()
      .min(60, 'Use at least one minute')
      .max(2_592_000),
    repeat: z.enum(REPEATS).default('none'),
    public: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.durationSec > maxWindowSeconds(value.repeat)) {
      context.addIssue({
        code: 'custom',
        message:
          value.repeat === 'none'
            ? 'A maintenance window can last at most 30 days'
            : `A ${value.repeat} window must be shorter than one ${value.repeat === 'daily' ? 'day' : 'week'}`,
      });
    }
  });

export const maintenancePatchSchema = z
  .object({
    name: name.optional(),
    scope: z.unknown().optional(),
    startsAt: z.unknown().optional(),
    durationSec: z.coerce.number().int().min(60).max(2_592_000).optional(),
    repeat: z.enum(REPEATS).optional(),
    public: z.boolean().optional(),
  })
  .strict();

export const noteSchema = z
  .object({ message: z.string().trim().min(1, 'Write a note').max(2000) })
  .strict();
export const postmortemSchema = z
  .object({ text: z.string().max(20_000) })
  .strict();
export const assignSchema = z.object({ userId: uuid.nullable() }).strict();
export const closeSchema = z
  .object({
    message: z.preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.string().trim().max(500).optional(),
    ),
  })
  .strict();
