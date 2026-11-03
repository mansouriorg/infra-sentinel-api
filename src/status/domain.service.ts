import { resolveTxt } from 'node:dns/promises';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import {
  isIpLiteral,
  normalizeDomain,
  ownHosts,
  verificationRecord,
} from './status.model';
import type { PageRow } from './status.rows';
import type { DomainView } from './status.types';
import { isUniqueViolation, toIso } from '../common/time';

const CACHE_TTL_MS = 30_000;
const MAX_CACHE = 1000;

interface CacheEntry {
  at: number;
  slug: string | null;
}

@Injectable()
export class DomainService {
  resolveTxt: (name: string) => Promise<string[][]> = (name) =>
    resolveTxt(name);
  cacheMs = CACHE_TTL_MS;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly own: Set<string>;

  constructor(
    private readonly db: DatabaseService,
    config: AppConfig,
  ) {
    this.own = ownHosts(config.get('WEB_URL'), config.get('PUBLIC_API_URL'));
  }

  isOwnHost(host: string): boolean {
    return host === '' || this.own.has(host) || isIpLiteral(host);
  }

  invalidate(): void {
    this.cache.clear();
  }

  async lookup(host: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.cache.get(host);
    if (cached && now - cached.at < this.cacheMs) return cached.slug;
    const row = await this.db.row<{ slug: string }>(
      'SELECT slug FROM status_pages WHERE custom_domain = $1 AND domain_verified_at IS NOT NULL',
      [host],
    );
    if (this.cache.size >= MAX_CACHE) this.cache.clear();
    this.cache.set(host, { at: now, slug: row?.slug ?? null });
    return row?.slug ?? null;
  }

  async allowed(domain: string): Promise<boolean> {
    const normalized = normalizeDomain(domain);
    if (!normalized) return false;
    const row = await this.db.row<{ id: string }>(
      'SELECT id FROM status_pages WHERE custom_domain = $1 AND domain_verified_at IS NOT NULL',
      [normalized],
    );
    return Boolean(row);
  }

  view(
    row: Pick<PageRow, 'custom_domain' | 'domain_token' | 'domain_verified_at'>,
  ): DomainView | null {
    if (!row.custom_domain) return null;
    const record = verificationRecord(row.custom_domain, row.domain_token);
    return {
      name: row.custom_domain,
      verified: Boolean(row.domain_verified_at),
      verifiedAt: row.domain_verified_at ? toIso(row.domain_verified_at) : null,
      recordName: record.name,
      recordValue: record.value,
    };
  }

  async set(
    orgId: string,
    pageId: string,
    input: string | null,
  ): Promise<PageRow | undefined> {
    const page = await this.db.row<PageRow>(
      'SELECT * FROM status_pages WHERE id = $1 AND org_id = $2',
      [pageId, orgId],
    );
    if (!page) return undefined;
    const wanted =
      input === null || input.trim() === '' ? null : normalizeDomain(input);
    if (input !== null && input.trim() !== '' && wanted === null) {
      throw new BadRequestException(
        'Enter a domain such as status.example.com',
      );
    }
    if (wanted !== null && this.isOwnHost(wanted)) {
      throw new BadRequestException(
        'That is the address of this application, choose a different domain',
      );
    }
    if (wanted === page.custom_domain) return page;
    const updated = await this.db.row<PageRow>(
      `UPDATE status_pages SET custom_domain = $3, domain_verified_at = NULL,
              domain_token = replace(gen_random_uuid()::text, '-', ''), updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [pageId, orgId, wanted],
    );
    this.invalidate();
    return updated;
  }

  async verify(orgId: string, pageId: string): Promise<PageRow | undefined> {
    const page = await this.db.row<PageRow>(
      'SELECT * FROM status_pages WHERE id = $1 AND org_id = $2',
      [pageId, orgId],
    );
    if (!page) return undefined;
    if (!page.custom_domain)
      throw new BadRequestException('Add a custom domain first');
    if (page.domain_verified_at) return page;
    const record = verificationRecord(page.custom_domain, page.domain_token);
    let values: string[] = [];
    try {
      const answers = await this.resolveTxt(record.name);
      values = answers.map((chunks) => chunks.join('').trim());
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'ENOTFOUND' && code !== 'ENODATA' && code !== 'NXDOMAIN') {
        throw new BadRequestException(
          'The DNS lookup failed. Try again in a moment.',
        );
      }
    }
    if (!values.includes(record.value)) {
      throw new BadRequestException(
        `We could not find the TXT record ${record.name} with the value ${record.value}. DNS changes can take a while, check the record and try again.`,
      );
    }
    try {
      const updated = await this.db.row<PageRow>(
        'UPDATE status_pages SET domain_verified_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *',
        [pageId, orgId],
      );
      this.invalidate();
      return updated;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          'Another status page already uses this domain',
        );
      throw error;
    }
  }
}
