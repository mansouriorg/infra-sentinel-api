import { z } from 'zod';

export const LOCALES = ['en', 'fr', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

export const NOTICE_CATEGORIES = [
  'incidents',
  'servers',
  'team',
  'system',
] as const;
export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

export interface PreferencesView {
  locale: Locale | null;
  notifyCategories: NoticeCategory[];
}

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
  );
}

export function orderedCategories(values: readonly string[]): NoticeCategory[] {
  return NOTICE_CATEGORIES.filter((category) => values.includes(category));
}

export const preferencesSchema = z
  .object({
    locale: z.enum(LOCALES).nullable().optional(),
    notifyCategories: z
      .array(z.enum(NOTICE_CATEGORIES))
      .max(NOTICE_CATEGORIES.length)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.locale !== undefined || value.notifyCategories !== undefined,
    'Nothing to change',
  );

export type PreferencesInput = z.infer<typeof preferencesSchema>;
