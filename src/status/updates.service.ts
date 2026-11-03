import { BadRequestException, Injectable } from '@nestjs/common';
import { notFound } from '../alerting/alert.helpers';
import type { AuthContext } from '../auth/auth.types';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { impactOf, suggestedTitle } from './status.model';
import { PublicStatusService } from './public.service';
import { publicBase, type PageRow } from './status.rows';
import { incidentStatusSchema, parseWith, updateSchema } from './status.schema';
import type {
  IncidentState,
  IncidentStatusView,
  StatusUpdateView,
} from './status.types';
import { toIso } from '../common/time';

interface IncidentLite {
  id: string;
  source: 'monitor' | 'server';
  monitor_id: string | null;
  server_id: string | null;
  server_metric: string;
  trigger: 'down' | 'degraded';
  status: 'open' | 'acknowledged' | 'resolved';
  title: string;
  monitor_name: string;
  public_title: string;
  public_hidden: boolean;
}

interface UpdateRow {
  id: string;
  state: IncidentState;
  message: string;
  created_at: Date;
  author_id: string | null;
  author_name: string | null;
}

interface PageLabel extends PageRow {
  label: string;
}

const MAX_UPDATES_PER_INCIDENT = 100;

@Injectable()
export class UpdatesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly status: PublicStatusService,
  ) {}

  private async incident(orgId: string, id: string): Promise<IncidentLite> {
    const row = await this.db.row<IncidentLite>(
      `SELECT id, source, monitor_id, server_id, server_metric, trigger, status, title, monitor_name, public_title, public_hidden
         FROM incidents WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (!row) throw notFound('Incident');
    return row;
  }

  private pagesFor(incident: IncidentLite): Promise<PageLabel[]> {
    if (incident.source === 'monitor' && incident.monitor_id) {
      return this.db.rows<PageLabel>(
        `SELECT p.*, c.label FROM status_components c JOIN status_pages p ON p.id = c.page_id
          WHERE c.monitor_id = $1 ORDER BY p.created_at`,
        [incident.monitor_id],
      );
    }
    if (
      incident.source === 'server' &&
      incident.server_id &&
      incident.server_metric === 'offline'
    ) {
      return this.db.rows<PageLabel>(
        `SELECT p.*, c.label FROM status_components c JOIN status_pages p ON p.id = c.page_id
          WHERE c.server_id = $1 ORDER BY p.created_at`,
        [incident.server_id],
      );
    }
    return Promise.resolve([]);
  }

  private async updates(incidentId: string): Promise<StatusUpdateView[]> {
    const rows = await this.db.rows<UpdateRow>(
      `SELECT u.id, u.state, u.message, u.created_at, u.author_id, a.name AS author_name
         FROM status_updates u LEFT JOIN users a ON a.id = u.author_id
        WHERE u.incident_id = $1 ORDER BY u.created_at DESC`,
      [incidentId],
    );
    return rows.map((row) => ({
      id: row.id,
      state: row.state,
      message: row.message,
      createdAt: toIso(row.created_at),
      author:
        row.author_id && row.author_name
          ? { id: row.author_id, name: row.author_name }
          : null,
    }));
  }

  async view(
    auth: AuthContext,
    incidentId: string,
  ): Promise<IncidentStatusView> {
    const incident = await this.incident(auth.orgId, incidentId);
    const pages = await this.pagesFor(incident);
    const label = pages[0]?.label ?? incident.monitor_name;
    return {
      incidentId: incident.id,
      publicTitle: incident.public_title,
      suggestedTitle: suggestedTitle(
        label,
        impactOf(incident.source, incident.trigger),
      ),
      hidden: incident.public_hidden,
      resolved: incident.status === 'resolved',
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        slug: page.slug,
        published: page.published,
        publicUrl: publicBase(this.config.get('WEB_URL'), page),
      })),
      updates: await this.updates(incident.id),
    };
  }

  async post(
    auth: AuthContext,
    incidentId: string,
    body: unknown,
  ): Promise<IncidentStatusView> {
    const input = parseWith(updateSchema, body);
    const incident = await this.incident(auth.orgId, incidentId);
    const pages = await this.pagesFor(incident);
    if (pages.length === 0)
      throw new BadRequestException(
        'This incident is not shown on any status page',
      );
    if (input.state === 'resolved' && incident.status !== 'resolved') {
      throw new BadRequestException(
        'Resolve the incident first, or pick Investigating, Identified or Monitoring',
      );
    }
    const posted = await this.db.row<{ n: number }>(
      'SELECT count(*)::int AS n FROM status_updates WHERE incident_id = $1',
      [incident.id],
    );
    if ((posted?.n ?? 0) >= MAX_UPDATES_PER_INCIDENT) {
      throw new BadRequestException(
        `An incident can have up to ${MAX_UPDATES_PER_INCIDENT} public updates`,
      );
    }
    await this.db.run(
      'INSERT INTO status_updates (incident_id, org_id, state, message, author_id) VALUES ($1, $2, $3, $4, $5::uuid)',
      [incident.id, auth.orgId, input.state, input.message, auth.user.id],
    );
    for (const page of pages) this.status.invalidate(page.id);
    return this.view(auth, incidentId);
  }

  async removeUpdate(
    auth: AuthContext,
    incidentId: string,
    updateId: string,
  ): Promise<IncidentStatusView> {
    const incident = await this.incident(auth.orgId, incidentId);
    const removed = await this.db.run(
      'DELETE FROM status_updates WHERE id = $1 AND incident_id = $2 AND org_id = $3',
      [updateId, incident.id, auth.orgId],
    );
    if (removed === 0) throw notFound('Update');
    for (const page of await this.pagesFor(incident))
      this.status.invalidate(page.id);
    return this.view(auth, incidentId);
  }

  async patch(
    auth: AuthContext,
    incidentId: string,
    body: unknown,
  ): Promise<IncidentStatusView> {
    const input = parseWith(incidentStatusSchema, body);
    const incident = await this.incident(auth.orgId, incidentId);
    await this.db.run(
      `UPDATE incidents SET public_title = COALESCE($3, public_title), public_hidden = COALESCE($4::boolean, public_hidden), updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [
        incident.id,
        auth.orgId,
        input.publicTitle ?? null,
        input.hidden ?? null,
      ],
    );
    for (const page of await this.pagesFor(incident))
      this.status.invalidate(page.id);
    return this.view(auth, incidentId);
  }
}
