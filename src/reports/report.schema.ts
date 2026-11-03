import { z } from 'zod';
import { parseWith } from '../monitors/monitor.schema';
import { REPORT_FORMATS, REPORT_PERIODS } from './report.types';

export { parseWith };

const list = (item: z.ZodString, max: number) =>
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).max(max));

const tag = z
  .string()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,23}$/,
    'Tags use letters, numbers, dashes and underscores',
  );

export const reportQuerySchema = z.object({
  period: z.enum(REPORT_PERIODS).default('last30'),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  target: z.coerce
    .number()
    .min(50, 'The target must be between 50 and 100')
    .max(100, 'The target must be between 50 and 100')
    .default(99.9),
  monitorIds: list(z.string().uuid('Invalid monitor id'), 300),
  serverIds: list(z.string().uuid('Invalid server id'), 300),
  tags: list(tag, 20),
  includeDegraded: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  format: z.enum(REPORT_FORMATS).default('json'),
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const timeZone = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

export const digestSchema = z
  .object({
    enabled: z.boolean(),
    weekday: z.coerce.number().int().min(0).max(6),
    hour: z.coerce.number().int().min(0).max(23),
    timeZone,
    recipients: z.enum(['admins', 'everyone']),
    extraEmails: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .email('Enter valid email addresses')
          .max(200),
      )
      .max(10, 'Use at most 10 extra addresses')
      .default([]),
  })
  .strict()
  .transform((value) => ({
    ...value,
    extraEmails: [...new Set(value.extraEmails)],
  }));

export type DigestInput = z.infer<typeof digestSchema>;
