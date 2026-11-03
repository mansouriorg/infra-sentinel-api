import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { LiveEvent } from '../monitors/monitor.types';

export interface EventInfo {
  id: string;
  label: string;
  description: string;
}

export const WEBHOOK_EVENTS = [
  {
    id: 'monitor.status_changed',
    label: 'Monitor status changed',
    description:
      'A monitor went down, recovered, became degraded, or was paused or resumed.',
  },
  {
    id: 'monitor.created',
    label: 'Monitor created',
    description: 'Someone added a monitor.',
  },
  {
    id: 'monitor.updated',
    label: 'Monitor changed',
    description: 'Someone edited a monitor.',
  },
  {
    id: 'monitor.deleted',
    label: 'Monitor deleted',
    description: 'Someone removed a monitor.',
  },
  {
    id: 'incident.opened',
    label: 'Incident opened',
    description: 'A new incident started.',
  },
  {
    id: 'incident.updated',
    label: 'Incident updated',
    description: 'An incident was acknowledged, reassigned or got a note.',
  },
  {
    id: 'incident.resolved',
    label: 'Incident resolved',
    description: 'An incident ended.',
  },
  {
    id: 'server.status_changed',
    label: 'Server status changed',
    description: 'A server went offline or came back online.',
  },
  {
    id: 'server.created',
    label: 'Server added',
    description: 'A new server enrolled its agent.',
  },
  {
    id: 'server.deleted',
    label: 'Server removed',
    description: 'Someone removed a server.',
  },
] as const satisfies readonly EventInfo[];

export type WebhookEventType =
  | (typeof WEBHOOK_EVENTS)[number]['id']
  | 'test.ping';

const KNOWN = WEBHOOK_EVENTS.map((event) => event.id) as readonly string[];

export const MAX_ENDPOINTS = 20;
export const MAX_ATTEMPTS = 6;
export const AUTO_DISABLE_AFTER = 20;
export const MAX_PENDING_PER_ENDPOINT = 500;
export const SIGNATURE_TOLERANCE_SEC = 300;

const BACKOFF_SEC = [30, 120, 600, 3600, 21_600] as const;

export function backoffSeconds(attemptsMade: number): number {
  return BACKOFF_SEC[
    Math.min(Math.max(attemptsMade, 1), BACKOFF_SEC.length) - 1
  ];
}

export function eventTypeFor(event: LiveEvent): WebhookEventType | null {
  switch (event.type) {
    case 'status':
      return 'monitor.status_changed';
    case 'monitor':
      return `monitor.${event.change}` as WebhookEventType;
    case 'incident':
      return `incident.${event.change === 'opened' ? 'opened' : event.change === 'resolved' ? 'resolved' : 'updated'}` as WebhookEventType;
    case 'server':
      if (event.change === 'status') return 'server.status_changed';
      if (event.change === 'created') return 'server.created';
      if (event.change === 'deleted') return 'server.deleted';
      return null;
    default:
      return null;
  }
}

export function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function signature(
  secret: string,
  body: string,
  timestampSec: number,
): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestampSec}.${body}`)
    .digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec: number = SIGNATURE_TOLERANCE_SEC,
): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(',').map((part) => part.trim().split('=') as [string, string]),
  );
  const timestamp = Number(parts.get('t'));
  const given = parts.get('v1');
  if (!Number.isInteger(timestamp) || !given) return false;
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;
  const expected = Buffer.from(
    signature(secret, body, timestamp).split('v1=')[1],
  );
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface Envelope {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  organizationId: string;
  data: Record<string, unknown>;
}

export function envelope(
  id: string,
  type: WebhookEventType,
  organizationId: string,
  data: Record<string, unknown>,
  now: number = Date.now(),
): Envelope {
  return {
    id,
    type,
    createdAt: new Date(now).toISOString(),
    organizationId,
    data,
  };
}

export function scrubTarget(target: string): string {
  if (!/^https?:\/\//i.test(target)) return target;
  try {
    const url = new URL(target);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return target;
  }
}

export function checkWebhookUrl(
  raw: string,
  requireHttps: boolean,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a full address such as https://example.com/hooks/sentinel';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return 'The address must start with https:// or http://';
  if (requireHttps && url.protocol !== 'https:')
    return 'The address must start with https://';
  if (url.username || url.password)
    return 'Remove the user name and password from the address';
  if (url.hash) return 'Remove the # part of the address';
  if (!url.hostname) return 'The address needs a host name';
  return null;
}

const names = z
  .string()
  .trim()
  .min(1, 'Give the endpoint a name')
  .max(60, 'The name can have at most 60 characters');
const address = z
  .string()
  .trim()
  .min(1, 'Enter the address to send events to')
  .max(2000, 'The address is too long');
const events = z
  .array(z.string())
  .min(1, 'Choose at least one event')
  .max(WEBHOOK_EVENTS.length)
  .superRefine((value, context) => {
    const unknown = value.filter((event) => !KNOWN.includes(event));
    if (unknown.length > 0)
      context.addIssue({
        code: 'custom',
        message: `Unknown event: ${unknown[0]}`,
      });
  })
  .transform((value) => KNOWN.filter((event) => value.includes(event)));

export const createWebhookSchema = z.object({
  name: names,
  url: address,
  events,
});

export const updateWebhookSchema = z
  .object({
    name: names.optional(),
    url: address.optional(),
    events: events.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change');

export const deliveryQuerySchema = z.object({
  status: z
    .enum(['pending', 'success', 'failed'])
    .optional()
    .or(z.literal('').transform(() => undefined)),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z
    .string()
    .datetime()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
