import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { parseWith } from '../monitors/monitor.schema';
import {
  NOTICE_CATEGORIES,
  isLocale,
  orderedCategories,
  preferencesSchema,
  type PreferencesView,
} from './preferences.types';

interface PreferencesRow {
  locale: string | null;
  notify_categories: string[];
}

@Injectable()
export class PreferencesService {
  constructor(private readonly db: DatabaseService) {}

  async get(userId: string): Promise<PreferencesView> {
    const row = await this.db.row<PreferencesRow>(
      'SELECT locale, notify_categories FROM user_preferences WHERE user_id = $1',
      [userId],
    );
    return toView(row);
  }

  async update(auth: AuthContext, body: unknown): Promise<PreferencesView> {
    const input = parseWith(preferencesSchema, body);
    const categories = input.notifyCategories
      ? orderedCategories(input.notifyCategories)
      : null;
    const row = await this.db.row<PreferencesRow>(
      `INSERT INTO user_preferences (user_id, locale, notify_categories)
       VALUES ($1, $2, COALESCE($3::text[], ARRAY['incidents', 'servers', 'team', 'system']))
       ON CONFLICT (user_id) DO UPDATE
         SET locale = CASE WHEN $4::boolean THEN EXCLUDED.locale ELSE user_preferences.locale END,
             notify_categories = CASE WHEN $3::text[] IS NULL THEN user_preferences.notify_categories ELSE EXCLUDED.notify_categories END,
             updated_at = now()
       RETURNING locale, notify_categories`,
      [
        auth.user.id,
        input.locale ?? null,
        categories,
        input.locale !== undefined,
      ],
    );
    return toView(row);
  }
}

function toView(row: PreferencesRow | undefined): PreferencesView {
  return {
    locale: row && isLocale(row.locale) ? row.locale : null,
    notifyCategories: row
      ? orderedCategories(row.notify_categories)
      : [...NOTICE_CATEGORIES],
  };
}
