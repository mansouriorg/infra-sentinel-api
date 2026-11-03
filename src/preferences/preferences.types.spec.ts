import {
  LOCALES,
  NOTICE_CATEGORIES,
  isLocale,
  orderedCategories,
  preferencesSchema,
} from './preferences.types';

describe('preferences', () => {
  it('offers English, French and Arabic', () => {
    expect([...LOCALES]).toEqual(['en', 'fr', 'ar']);
    expect(isLocale('fr')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(7)).toBe(false);
  });

  it('keeps categories in a fixed order without repeats or unknown values', () => {
    expect(
      orderedCategories(['team', 'incidents', 'incidents', 'billing']),
    ).toEqual(['incidents', 'team']);
    expect(orderedCategories([])).toEqual([]);
    expect(orderedCategories([...NOTICE_CATEGORIES].reverse())).toEqual([
      ...NOTICE_CATEGORIES,
    ]);
  });

  it('accepts a language, categories, or both', () => {
    expect(preferencesSchema.safeParse({ locale: 'ar' }).success).toBe(true);
    expect(preferencesSchema.safeParse({ locale: null }).success).toBe(true);
    expect(preferencesSchema.safeParse({ notifyCategories: [] }).success).toBe(
      true,
    );
    expect(
      preferencesSchema.safeParse({ locale: 'fr', notifyCategories: ['team'] })
        .success,
    ).toBe(true);
  });

  it('refuses anything else', () => {
    expect(preferencesSchema.safeParse({}).success).toBe(false);
    expect(preferencesSchema.safeParse({ locale: 'de' }).success).toBe(false);
    expect(
      preferencesSchema.safeParse({ notifyCategories: ['billing'] }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({ locale: 'fr', theme: 'dark' }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({ notifyCategories: 'team' }).success,
    ).toBe(false);
  });
});
