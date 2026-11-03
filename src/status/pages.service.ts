import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { assertOwned, notFound } from '../alerting/alert.helpers';
import type { AuthContext } from '../auth/auth.types';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { DomainService } from './domain.service';
import { PublicStatusService } from './public.service';
import { slugify } from './status.model';
import { publicBase, type PageRow } from './status.rows';
import {
  componentsSchema,
  createPageSchema,
  domainSchema,
  parseWith,
  patchPageSchema,
  SLUG_PATTERN,
} from './status.schema';
import type {
  StatusComponentView,
  StatusPageDetail,
  StatusPageView,
  SubscriberView,
} from './status.types';
import { isUniqueViolation, toIso } from '../common/time';

export const MAX_PAGES = 10;

interface CountedRow extends PageRow {
  component_count: number;
  subscriber_count: number;
}

interface ComponentRow {
  id: string;
  kind: 'monitor' | 'server';
  subject_id: string;
  name: string | null;
  label: string;
  group_name: string;
  position: number;
}

const COLUMNS: Record<string, string> = {
  name: 'name',
  slug: 'slug',
  headline: 'headline',
  websiteUrl: 'website_url',
  logoUrl: 'logo_url',
  accent: 'accent',
  theme: 'theme',
  footer: 'footer',
  published: 'published',
  historyDays: 'history_days',
};

const TAKEN = 'That address is already taken, choose another one';

@Injectable()
export class PagesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly domains: DomainService,
    private readonly status: PublicStatusService,
  ) {}

  private view(row: CountedRow): StatusPageView {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      headline: row.headline,
      websiteUrl: row.website_url,
      logoUrl: row.logo_url,
      accent: row.accent,
      theme: row.theme,
      footer: row.footer,
      published: row.published,
      historyDays: row.history_days,
      publicUrl: publicBase(this.config.get('WEB_URL'), row),
      domain: this.domains.view(row),
      componentCount: Number(row.component_count ?? 0),
      subscriberCount: Number(row.subscriber_count ?? 0),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private counted(where: string): string {
    return `SELECT p.*,
              (SELECT count(*)::int FROM status_components c WHERE c.page_id = p.id) AS component_count,
              (SELECT count(*)::int FROM status_subscribers s WHERE s.page_id = p.id AND s.confirmed_at IS NOT NULL) AS subscriber_count
         FROM status_pages p WHERE ${where}`;
  }

  private async load(orgId: string, id: string): Promise<CountedRow> {
    const row = await this.db.row<CountedRow>(
      this.counted('p.id = $1 AND p.org_id = $2'),
      [id, orgId],
    );
    if (!row) throw notFound('Status page');
    return row;
  }

  async list(auth: AuthContext): Promise<StatusPageView[]> {
    const rows = await this.db.rows<CountedRow>(
      `${this.counted('p.org_id = $1')} ORDER BY p.created_at`,
      [auth.orgId],
    );
    return rows.map((row) => this.view(row));
  }

  async get(auth: AuthContext, id: string): Promise<StatusPageDetail> {
    const row = await this.load(auth.orgId, id);
    return this.detail(row);
  }

  private async detail(row: CountedRow): Promise<StatusPageDetail> {
    const components = await this.db.rows<ComponentRow>(
      `SELECT c.id, c.kind, COALESCE(c.monitor_id, c.server_id) AS subject_id, COALESCE(m.name, s.name) AS name,
              c.label, c.group_name, c.position
         FROM status_components c
         LEFT JOIN monitors m ON m.id = c.monitor_id
         LEFT JOIN servers s ON s.id = c.server_id
        WHERE c.page_id = $1 ORDER BY c.position, lower(c.label)`,
      [row.id],
    );
    const views: StatusComponentView[] = components.map((component) => ({
      id: component.id,
      kind: component.kind,
      subjectId: component.subject_id,
      name: component.name ?? component.label,
      label: component.label,
      group: component.group_name,
      position: component.position,
    }));
    return { ...this.view(row), components: views };
  }

  async create(auth: AuthContext, body: unknown): Promise<StatusPageDetail> {
    const input = parseWith(createPageSchema, body);
    const count = await this.db.row<{ n: number }>(
      'SELECT count(*)::int AS n FROM status_pages WHERE org_id = $1',
      [auth.orgId],
    );
    if ((count?.n ?? 0) >= MAX_PAGES)
      throw new BadRequestException(
        `A workspace can have at most ${MAX_PAGES} status pages`,
      );

    const explicit = input.slug;
    const base =
      explicit ??
      (slugify(input.name) || `status-${randomBytes(3).toString('hex')}`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const slug = `${base.slice(0, 40 - suffix.length)}${suffix}`.replace(
        /-+$/,
        '',
      );
      if (!SLUG_PATTERN.test(slug)) continue;
      try {
        const row = await this.db.row<PageRow>(
          `INSERT INTO status_pages (org_id, slug, name, created_by) VALUES ($1, $2, $3, $4::uuid) RETURNING id`,
          [auth.orgId, slug, input.name, auth.user.id],
        );
        if (!row) throw new Error('Status page was not created');
        return this.detail(await this.load(auth.orgId, row.id));
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (explicit) throw new ConflictException(TAKEN);
      }
    }
    throw new ConflictException(TAKEN);
  }

  async update(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<StatusPageDetail> {
    const patch = parseWith(patchPageSchema, body) as Record<string, unknown>;
    const entries = Object.entries(patch).filter(
      ([key, value]) => value !== undefined && key in COLUMNS,
    );
    await this.load(auth.orgId, id);
    if (entries.length > 0) {
      const sets = entries.map(
        ([key], index) => `${COLUMNS[key]} = $${index + 3}`,
      );
      try {
        await this.db.run(
          `UPDATE status_pages SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND org_id = $2`,
          [id, auth.orgId, ...entries.map(([, value]) => value)],
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException(TAKEN);
        throw error;
      }
      this.status.invalidate(id);
    }
    return this.detail(await this.load(auth.orgId, id));
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    const removed = await this.db.run(
      'DELETE FROM status_pages WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
    if (removed === 0) throw notFound('Status page');
    this.status.invalidate(id);
    this.domains.invalidate();
  }

  async setComponents(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<StatusPageDetail> {
    const input = parseWith(componentsSchema, body);
    await this.load(auth.orgId, id);
    const seen = new Set<string>();
    for (const item of input.components) {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key))
        throw new BadRequestException('A component can only be added once');
      seen.add(key);
    }
    const monitorIds = input.components
      .filter((item) => item.kind === 'monitor')
      .map((item) => item.id);
    const serverIds = input.components
      .filter((item) => item.kind === 'server')
      .map((item) => item.id);
    await assertOwned(this.db, 'monitors', auth.orgId, monitorIds);
    await assertOwned(this.db, 'servers', auth.orgId, serverIds);
    const names = new Map<string, string>();
    if (monitorIds.length > 0) {
      for (const row of await this.db.rows<{ id: string; name: string }>(
        'SELECT id, name FROM monitors WHERE id = ANY($1::uuid[])',
        [monitorIds],
      )) {
        names.set(`monitor:${row.id}`, row.name);
      }
    }
    if (serverIds.length > 0) {
      for (const row of await this.db.rows<{ id: string; name: string }>(
        'SELECT id, name FROM servers WHERE id = ANY($1::uuid[])',
        [serverIds],
      )) {
        names.set(`server:${row.id}`, row.name);
      }
    }
    await this.db.tx(async (tx) => {
      await tx.run('DELETE FROM status_components WHERE page_id = $1', [id]);
      for (const [position, item] of input.components.entries()) {
        const label = (
          item.label ??
          names.get(`${item.kind}:${item.id}`) ??
          'Component'
        ).slice(0, 80);
        await tx.run(
          `INSERT INTO status_components (page_id, kind, monitor_id, server_id, label, group_name, position)
           VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6, $7::int)`,
          [
            id,
            item.kind,
            item.kind === 'monitor' ? item.id : null,
            item.kind === 'server' ? item.id : null,
            label,
            item.group ?? '',
            position,
          ],
        );
      }
    });
    this.status.invalidate(id);
    return this.detail(await this.load(auth.orgId, id));
  }

  async setDomain(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<StatusPageDetail> {
    const input = parseWith(domainSchema, body);
    const updated = await this.domains.set(auth.orgId, id, input.domain);
    if (!updated) throw notFound('Status page');
    this.status.invalidate(id);
    return this.detail(await this.load(auth.orgId, id));
  }

  async verifyDomain(auth: AuthContext, id: string): Promise<StatusPageDetail> {
    const updated = await this.domains.verify(auth.orgId, id);
    if (!updated) throw notFound('Status page');
    this.status.invalidate(id);
    return this.detail(await this.load(auth.orgId, id));
  }

  async subscribers(auth: AuthContext, id: string): Promise<SubscriberView[]> {
    await this.load(auth.orgId, id);
    const rows = await this.db.rows<{
      id: string;
      email: string;
      confirmed_at: Date | null;
      created_at: Date;
    }>(
      'SELECT id, email, confirmed_at, created_at FROM status_subscribers WHERE page_id = $1 ORDER BY created_at DESC LIMIT 1000',
      [id],
    );
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      confirmed: Boolean(row.confirmed_at),
      createdAt: toIso(row.created_at),
      confirmedAt: row.confirmed_at ? toIso(row.confirmed_at) : null,
    }));
  }

  async removeSubscriber(
    auth: AuthContext,
    id: string,
    subscriberId: string,
  ): Promise<void> {
    await this.load(auth.orgId, id);
    const removed = await this.db.run(
      'DELETE FROM status_subscribers WHERE id = $1 AND page_id = $2',
      [subscriberId, id],
    );
    if (removed === 0) throw notFound('Subscriber');
  }
}
