import { z } from 'zod';
import {
  NOTICE_CATEGORIES,
  type NoticeCategory,
} from '../preferences/preferences.types';

export type NoticeAudience = 'all' | 'admins';

interface KindRule {
  category: NoticeCategory;
  audience: NoticeAudience;
}

export const NOTICE_KINDS = {
  'incident.opened': { category: 'incidents', audience: 'all' },
  'incident.resolved': { category: 'incidents', audience: 'all' },
  'server.offline': { category: 'servers', audience: 'all' },
  'server.online': { category: 'servers', audience: 'all' },
  'team.member_joined': { category: 'team', audience: 'admins' },
  'webhook.disabled': { category: 'system', audience: 'admins' },
  'api_key.expiring': { category: 'system', audience: 'admins' },
} as const satisfies Record<string, KindRule>;

export type NoticeKind = keyof typeof NOTICE_KINDS;

export interface NoticeInput {
  orgId: string;
  kind: NoticeKind;
  data: Record<string, unknown>;
  dedupe?: string;
}

export interface NoticeView {
  id: string;
  kind: string;
  category: NoticeCategory;
  data: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}

export interface NoticePage {
  items: NoticeView[];
  unread: number;
  nextBefore: string | null;
}

export const KEY_EXPIRY_WARNING_DAYS = 7;

export function isNoticeCategory(value: string): value is NoticeCategory {
  return (NOTICE_CATEGORIES as readonly string[]).includes(value);
}

const marker = z
  .string()
  .regex(/^\d{1,18}$/, 'Invalid page marker')
  .optional()
  .or(z.literal('').transform(() => undefined));

export const noticeQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: marker,
  unread: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => value === 'true' || value === '1'),
});

export const markReadSchema = z
  .object({
    ids: z
      .array(z.string().regex(/^\d{1,18}$/, 'Invalid notification id'))
      .min(1)
      .max(100)
      .optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => (value.ids !== undefined) !== (value.all === true),
    'Send either ids or all',
  );

export type MarkReadInput = z.infer<typeof markReadSchema>;
