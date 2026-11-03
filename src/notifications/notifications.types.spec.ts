import { NOTICE_CATEGORIES } from '../preferences/preferences.types';
import {
  KEY_EXPIRY_WARNING_DAYS,
  NOTICE_KINDS,
  isNoticeCategory,
  markReadSchema,
  noticeQuerySchema,
} from './notifications.types';

describe('notification rules', () => {
  it('puts every kind in a category people can switch off', () => {
    for (const [kind, rule] of Object.entries(NOTICE_KINDS)) {
      expect(kind).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(
        (NOTICE_CATEGORIES as readonly string[]).includes(rule.category),
      ).toBe(true);
      expect(['all', 'admins']).toContain(rule.audience);
    }
  });

  it('shows incident and server news to everyone and team or system news to admins', () => {
    expect(NOTICE_KINDS['incident.opened'].audience).toBe('all');
    expect(NOTICE_KINDS['server.offline'].audience).toBe('all');
    expect(NOTICE_KINDS['team.member_joined'].audience).toBe('admins');
    expect(NOTICE_KINDS['webhook.disabled'].audience).toBe('admins');
    expect(NOTICE_KINDS['api_key.expiring'].audience).toBe('admins');
  });

  it('warns about keys a week ahead', () => {
    expect(KEY_EXPIRY_WARNING_DAYS).toBe(7);
  });

  it('recognises categories', () => {
    expect(isNoticeCategory('servers')).toBe(true);
    expect(isNoticeCategory('billing')).toBe(false);
  });
});

describe('notification list query', () => {
  it('uses sensible defaults', () => {
    expect(noticeQuerySchema.parse({})).toEqual({ limit: 20, unread: false });
  });

  it('reads text values from the address bar', () => {
    expect(
      noticeQuerySchema.parse({ limit: '5', before: '120', unread: 'true' }),
    ).toEqual({ limit: 5, before: '120', unread: true });
    expect(noticeQuerySchema.parse({ unread: '1' }).unread).toBe(true);
    expect(noticeQuerySchema.parse({ unread: '0' }).unread).toBe(false);
    expect(noticeQuerySchema.parse({ before: '' }).before).toBeUndefined();
  });

  it('refuses out-of-range or malformed values', () => {
    expect(noticeQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(noticeQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(noticeQuerySchema.safeParse({ limit: 'many' }).success).toBe(false);
    expect(noticeQuerySchema.safeParse({ before: 'abc' }).success).toBe(false);
    expect(
      noticeQuerySchema.safeParse({ before: '1'.repeat(19) }).success,
    ).toBe(false);
    expect(noticeQuerySchema.safeParse({ unread: 'maybe' }).success).toBe(
      false,
    );
  });
});

describe('marking notifications read', () => {
  it('takes ids or everything, never both and never neither', () => {
    expect(markReadSchema.safeParse({ ids: ['1', '22'] }).success).toBe(true);
    expect(markReadSchema.safeParse({ all: true }).success).toBe(true);
    expect(markReadSchema.safeParse({}).success).toBe(false);
    expect(markReadSchema.safeParse({ all: false }).success).toBe(false);
    expect(markReadSchema.safeParse({ ids: ['1'], all: true }).success).toBe(
      false,
    );
    expect(markReadSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(markReadSchema.safeParse({ ids: ['x'] }).success).toBe(false);
    expect(
      markReadSchema.safeParse({
        ids: Array.from({ length: 101 }, (_, i) => String(i + 1)),
      }).success,
    ).toBe(false);
    expect(markReadSchema.safeParse({ all: true, extra: 1 }).success).toBe(
      false,
    );
  });
});
