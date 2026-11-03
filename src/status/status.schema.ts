import { z } from 'zod';
import { parseWith } from '../monitors/monitor.schema';
import { INCIDENT_STATES, PAGE_THEMES } from './status.types';

export { parseWith };

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    SLUG_PATTERN,
    'The address uses 3 to 40 lowercase letters, numbers and dashes',
  );

const name = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(80, 'Use at most 80 characters');

const optionalUrl = z
  .string()
  .trim()
  .max(2048, 'That address is too long')
  .refine((value) => {
    if (value === '') return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Enter a full address such as https://example.com');

export const createPageSchema = z
  .object({ name, slug: slug.optional() })
  .strict();

export const patchPageSchema = z
  .object({
    name: name.optional(),
    slug: slug.optional(),
    headline: z
      .string()
      .trim()
      .max(200, 'Use at most 200 characters')
      .optional(),
    websiteUrl: optionalUrl.optional(),
    logoUrl: optionalUrl.optional(),
    accent: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Use a color such as #0e7490')
      .transform((value) => value.toLowerCase())
      .optional(),
    theme: z.enum(PAGE_THEMES).optional(),
    footer: z.string().trim().max(500, 'Use at most 500 characters').optional(),
    published: z.boolean().optional(),
    historyDays: z.coerce.number().int().min(7).max(90).optional(),
  })
  .strict();

export const componentsSchema = z
  .object({
    components: z
      .array(
        z
          .object({
            kind: z.enum(['monitor', 'server']),
            id: z.string().uuid('Invalid component'),
            label: z
              .string()
              .trim()
              .min(1, 'Every component needs a name')
              .max(80)
              .optional(),
            group: z.string().trim().max(60).optional(),
          })
          .strict(),
      )
      .max(200, 'A page can show at most 200 components'),
  })
  .strict();

export const domainSchema = z
  .object({ domain: z.string().trim().max(300).nullable() })
  .strict();

export const updateSchema = z
  .object({
    state: z.enum(INCIDENT_STATES),
    message: z
      .string()
      .trim()
      .min(1, 'Write a message')
      .max(2000, 'Use at most 2000 characters'),
  })
  .strict();

export const incidentStatusSchema = z
  .object({
    publicTitle: z
      .string()
      .trim()
      .max(120, 'Use at most 120 characters')
      .optional(),
    hidden: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.publicTitle !== undefined || value.hidden !== undefined,
    'Nothing to change',
  );

export const subscribeSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address')
    .max(254),
});

export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
