import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { parseWith } from '../monitors/monitor.schema';
import {
  buildView,
  onboardingSchema,
  type OnboardingView,
} from './onboarding.types';

interface CountsRow {
  monitors: string;
  rules: string;
  members: string;
  invites: string;
  servers: string;
  pages: string;
  dismissed_at: Date | string | null;
}

@Injectable()
export class OnboardingService {
  constructor(private readonly db: DatabaseService) {}

  async view(auth: AuthContext): Promise<OnboardingView> {
    const row = await this.db.row<CountsRow>(
      `SELECT
         (SELECT count(*) FROM monitors WHERE org_id = $1) AS monitors,
         (SELECT count(*) FROM alert_rules WHERE org_id = $1) AS rules,
         (SELECT count(*) FROM memberships WHERE org_id = $1) AS members,
         (SELECT count(*) FROM invitations WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now()) AS invites,
         (SELECT count(*) FROM servers WHERE org_id = $1) AS servers,
         (SELECT count(*) FROM status_pages WHERE org_id = $1) AS pages,
         (SELECT onboarding_dismissed_at FROM organizations WHERE id = $1) AS dismissed_at`,
      [auth.orgId],
    );
    return buildView(
      {
        monitors: Number(row?.monitors ?? 0),
        rules: Number(row?.rules ?? 0),
        members: Number(row?.members ?? 0),
        invites: Number(row?.invites ?? 0),
        servers: Number(row?.servers ?? 0),
        pages: Number(row?.pages ?? 0),
      },
      Boolean(row?.dismissed_at),
    );
  }

  async setDismissed(
    auth: AuthContext,
    body: unknown,
  ): Promise<OnboardingView> {
    const input = parseWith(onboardingSchema, body);
    await this.db.run(
      `UPDATE organizations SET onboarding_dismissed_at = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE id = $1`,
      [auth.orgId, input.dismissed],
    );
    return this.view(auth);
  }
}
