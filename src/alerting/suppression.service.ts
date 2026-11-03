import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { toMaintenanceView, toSilenceView } from './alert.format';
import { assertOwned, notFound } from './alert.helpers';
import {
  maintenancePatchSchema,
  maintenanceSchema,
  parseWith,
  silenceSchema,
} from './alert.schema';
import type {
  MaintenanceRow,
  MaintenanceView,
  SilenceRow,
  SilenceView,
} from './alert.types';

const MAX_SILENCES = 100;
const MAX_WINDOWS = 100;

@Injectable()
export class SuppressionService {
  constructor(private readonly db: DatabaseService) {}

  async listSilences(auth: AuthContext): Promise<SilenceView[]> {
    const rows = await this.db.rows<SilenceRow>(
      `SELECT * FROM silences
        WHERE org_id = $1 AND ends_at > now() - interval '7 days'
        ORDER BY ends_at DESC`,
      [auth.orgId],
    );
    const now = new Date();
    return rows.map((row) => toSilenceView(row, now));
  }

  async createSilence(auth: AuthContext, body: unknown): Promise<SilenceView> {
    const input = parseWith(silenceSchema, body);
    const count = await this.db.row<{ n: number }>(
      'SELECT count(*)::int AS n FROM silences WHERE org_id = $1 AND ends_at > now()',
      [auth.orgId],
    );
    if ((count?.n ?? 0) >= MAX_SILENCES)
      throw new BadRequestException('Too many active silences');
    await assertOwned(this.db, 'monitors', auth.orgId, input.scope.monitorIds);
    const row = await this.db.row<SilenceRow>(
      `INSERT INTO silences (org_id, name, scope_all, monitor_ids, tags, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, $4::uuid[], $5::text[], $6::timestamptz, $7::timestamptz, $8::uuid) RETURNING *`,
      [
        auth.orgId,
        input.name,
        input.scope.all,
        input.scope.monitorIds,
        input.scope.tags,
        input.startsAt,
        input.endsAt,
        auth.user.id,
      ],
    );
    if (!row) throw new Error('Silence was not created');
    return toSilenceView(row, new Date());
  }

  async removeSilence(auth: AuthContext, id: string): Promise<void> {
    const removed = await this.db.run(
      'DELETE FROM silences WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
    if (removed === 0) throw notFound('Silence');
  }

  async listWindows(auth: AuthContext): Promise<MaintenanceView[]> {
    const rows = await this.db.rows<MaintenanceRow>(
      'SELECT * FROM maintenance_windows WHERE org_id = $1 ORDER BY starts_at DESC',
      [auth.orgId],
    );
    const now = new Date();
    return rows.map((row) => toMaintenanceView(row, now));
  }

  async createWindow(
    auth: AuthContext,
    body: unknown,
  ): Promise<MaintenanceView> {
    const input = parseWith(maintenanceSchema, body);
    const count = await this.db.row<{ n: number }>(
      'SELECT count(*)::int AS n FROM maintenance_windows WHERE org_id = $1',
      [auth.orgId],
    );
    if ((count?.n ?? 0) >= MAX_WINDOWS)
      throw new BadRequestException('Too many maintenance windows');
    await assertOwned(this.db, 'monitors', auth.orgId, input.scope.monitorIds);
    const row = await this.db.row<MaintenanceRow>(
      `INSERT INTO maintenance_windows (org_id, name, scope_all, monitor_ids, tags, starts_at, duration_sec, repeat, created_by, public)
       VALUES ($1, $2, $3, $4::uuid[], $5::text[], $6::timestamptz, $7::int, $8, $9::uuid, $10::boolean) RETURNING *`,
      [
        auth.orgId,
        input.name,
        input.scope.all,
        input.scope.monitorIds,
        input.scope.tags,
        input.startsAt,
        input.durationSec,
        input.repeat,
        auth.user.id,
        input.public,
      ],
    );
    if (!row) throw new Error('Maintenance window was not created');
    return toMaintenanceView(row, new Date());
  }

  async updateWindow(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<MaintenanceView> {
    const patch = parseWith(maintenancePatchSchema, body);
    const row = await this.db.row<MaintenanceRow>(
      'SELECT * FROM maintenance_windows WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
    if (!row) throw notFound('Maintenance window');
    const merged = {
      name: row.name,
      scope: {
        all: row.scope_all,
        monitorIds: row.monitor_ids ?? [],
        tags: row.tags ?? [],
      },
      startsAt: row.starts_at,
      durationSec: row.duration_sec,
      repeat: row.repeat,
      public: Boolean(row.public),
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
    };
    const input = parseWith(maintenanceSchema, merged);
    await assertOwned(this.db, 'monitors', auth.orgId, input.scope.monitorIds);
    const updated = await this.db.row<MaintenanceRow>(
      `UPDATE maintenance_windows SET
         name = $3, scope_all = $4, monitor_ids = $5::uuid[], tags = $6::text[],
         starts_at = $7::timestamptz, duration_sec = $8::int, repeat = $9, public = $10::boolean, updated_at = now()
       WHERE id = $1 AND org_id = $2 RETURNING *`,
      [
        id,
        auth.orgId,
        input.name,
        input.scope.all,
        input.scope.monitorIds,
        input.scope.tags,
        input.startsAt,
        input.durationSec,
        input.repeat,
        input.public,
      ],
    );
    if (!updated) throw notFound('Maintenance window');
    return toMaintenanceView(updated, new Date());
  }

  async removeWindow(auth: AuthContext, id: string): Promise<void> {
    const removed = await this.db.run(
      'DELETE FROM maintenance_windows WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
    if (removed === 0) throw notFound('Maintenance window');
  }
}
