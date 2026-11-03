import type { PageTheme, PublicPageInfo } from './status.types';

export interface PageRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  headline: string;
  website_url: string;
  logo_url: string;
  accent: string;
  theme: PageTheme;
  footer: string;
  published: boolean;
  history_days: number;
  custom_domain: string | null;
  domain_token: string;
  domain_verified_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toPublicInfo(row: PageRow): PublicPageInfo {
  return {
    slug: row.slug,
    name: row.name,
    headline: row.headline,
    websiteUrl: row.website_url,
    logoUrl: row.logo_url,
    accent: row.accent,
    theme: row.theme,
    footer: row.footer,
    historyDays: row.history_days,
  };
}

export function publicBase(
  webUrl: string,
  row: Pick<PageRow, 'slug' | 'custom_domain' | 'domain_verified_at'>,
): string {
  if (row.custom_domain && row.domain_verified_at)
    return `https://${row.custom_domain}`;
  return `${webUrl.replace(/\/+$/, '')}/status/${row.slug}`;
}
