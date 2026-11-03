import { createHash } from 'node:crypto';
import { formatAvailability } from '../reports/availability';
import { escapeHtml } from '../mail/mail.templates';
import { STATE_LABELS, STATUS_LABELS } from './status.model';
import type {
  BarStatus,
  ComponentStatus,
  OverallStatus,
  PublicComponent,
  PublicIncident,
  PublicMaintenance,
  PublicPageInfo,
  PublicStatus,
} from './status.types';

export interface RenderContext {
  base: string;
  publicUrl: string;
}

export interface MessageOptions {
  page: PublicPageInfo | null;
  title: string;
  message: string;
  base: string;
  form?: { action: string; token: string; button: string };
  back?: boolean;
}

const REFRESH_SCRIPT =
  "setTimeout(function(){var i=document.querySelector('form input[type=email]');if(!i||(!i.value&&document.activeElement!==i))location.reload()},60000)";

const REFRESH_HASH = createHash('sha256')
  .update(REFRESH_SCRIPT)
  .digest('base64');

export const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${REFRESH_HASH}'`,
  'img-src https: http: data:',
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const STATIC_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const LIGHT =
  '--bg:#f5f7fa;--card:#ffffff;--text:#0e1621;--muted:#58667a;--line:#e1e6ed;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--maint:#1d4ed8;--none:#cbd5e1;--up:#22c55e;--minor:#f59e0b;--major:#ef4444;--shade:#eef2f6';
const DARK =
  '--bg:#0b1118;--card:#121a24;--text:#e6edf5;--muted:#93a1b5;--line:#243040;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--maint:#93c5fd;--none:#2c3a4d;--up:#22c55e;--minor:#f59e0b;--major:#ef4444;--shade:#17212d';

const CSS = `
:root{${LIGHT};color-scheme:light dark}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{${DARK};color-scheme:dark}
@media (prefers-color-scheme:dark){:root[data-theme=auto]{${DARK}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:color-mix(in srgb,var(--accent) 72%,var(--text))}
main{max-width:760px;margin:0 auto;padding:32px 16px 24px}
header.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:24px}
header.top img{height:40px;max-width:160px;object-fit:contain}
header.top .name{flex:1;min-width:0}
h1{font-size:22px;line-height:1.25;margin:0;overflow-wrap:anywhere}
.headline{margin:2px 0 0;color:var(--muted);overflow-wrap:anywhere}
.visit{display:inline-block;padding:7px 14px;border-radius:8px;background:var(--accent);color:var(--on-accent);text-decoration:none;font-size:14px;font-weight:600}
h2{font-size:15px;margin:32px 0 10px;font-weight:650}
.banner{display:flex;align-items:center;gap:12px;padding:16px 18px;border-radius:12px;font-weight:650;font-size:18px;color:var(--tone);background:color-mix(in srgb,var(--tone) 11%,var(--card));border:1px solid color-mix(in srgb,var(--tone) 35%,var(--line))}
.banner svg{flex:none}
.banner span{color:var(--text)}
.t-operational{--tone:var(--ok)}.t-degraded{--tone:var(--warn)}.t-partial{--tone:var(--bad)}.t-major,.t-outage{--tone:var(--bad)}.t-maintenance{--tone:var(--maint)}.t-unknown,.t-empty{--tone:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 12px}
.group{margin:0 0 12px}
.group>h3{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:16px 0 6px;font-weight:650}
.comp{padding:14px 18px;border-top:1px solid var(--line)}
.comp:first-child{border-top:0}
.comp .row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.comp .label{font-weight:600;overflow-wrap:anywhere}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--tone)}
.badge svg{width:14px;height:14px}
.bars{display:flex;gap:1px;height:30px;margin:10px 0 6px}
.bars i{flex:1 1 0;min-width:1px;border-radius:2px;background:var(--none)}
.bars i.up{background:var(--up)}.bars i.minor{background:var(--minor)}.bars i.major{background:var(--major)}.bars i.maintenance{background:var(--maint)}
.scale{display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}
.inc h3{font-size:16px;margin:0 0 4px;overflow-wrap:anywhere}
.chip{display:inline-block;font-size:12px;font-weight:650;padding:1px 8px;border-radius:999px;margin-left:8px;vertical-align:middle;color:var(--tone);border:1px solid color-mix(in srgb,var(--tone) 40%,var(--line));background:color-mix(in srgb,var(--tone) 9%,var(--card))}
.meta{margin:0 0 10px;font-size:13px;color:var(--muted)}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{padding:8px 0 8px 14px;border-left:2px solid var(--line);margin-left:4px}
.timeline strong{font-size:14px}
.timeline time{font-size:12px;color:var(--muted);margin-left:8px}
.timeline p{margin:2px 0 0;font-size:14px;overflow-wrap:anywhere}
.day{font-size:13px;font-weight:650;color:var(--muted);margin:20px 0 8px}
.empty{color:var(--muted);font-size:14px;margin:0}
form.sub{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
form.sub input[type=email]{flex:1 1 220px;min-width:0;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
form.sub input[type=email]:focus-visible,.btn:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.btn{padding:9px 16px;border-radius:8px;border:0;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;cursor:pointer}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.small{font-size:13px;color:var(--muted);margin:10px 0 0}
footer{max-width:760px;margin:0 auto;padding:8px 16px 40px;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.msg{max-width:480px;margin:12vh auto 0;text-align:center}
.msg h1{margin-bottom:8px}
.msg p{color:var(--muted)}
@media (max-width:480px){main{padding-top:20px}.banner{font-size:16px}}
`;

const ICONS: Record<ComponentStatus, string> = {
  operational:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  degraded:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 3 20h18L12 4Z"/><path d="M12 10v4M12 17v.5"/></svg>',
  outage:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
  maintenance:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6.5a4 4 0 0 0 4.9 4.9L20 12l-8 8a2.1 2.1 0 0 1-3-3l8-8-.5-2.5Z"/></svg>',
  unknown:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
};

const OVERALL_ICON: Record<OverallStatus, ComponentStatus> = {
  operational: 'operational',
  degraded: 'degraded',
  partial: 'outage',
  major: 'outage',
  maintenance: 'maintenance',
  unknown: 'unknown',
  empty: 'unknown',
};

export function readableOn(hex: string): string {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#0e7490';
  const channel = (index: number) => {
    const c = parseInt(value.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return luminance > 0.4 ? '#0b1118' : '#ffffff';
}

const dayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const hourFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatDayText(iso: string): string {
  return dayFormat.format(new Date(iso));
}

function formatTimeText(iso: string): string {
  return `${timeFormat.format(new Date(iso))} UTC`;
}

function timeTag(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(formatTimeText(iso))}</time>`;
}

function paragraphs(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function themeAttributes(page: PublicPageInfo | null): {
  theme: string;
  accent: string;
  onAccent: string;
} {
  const accent = page?.accent ?? '#0e7490';
  return { theme: page?.theme ?? 'auto', accent, onAccent: readableOn(accent) };
}

function documentShell(
  page: PublicPageInfo | null,
  title: string,
  head: string,
  body: string,
  script: boolean,
): string {
  const { theme, accent, onAccent } = themeAttributes(page);
  return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(theme)}" style="--accent:${escapeHtml(accent)};--on-accent:${escapeHtml(onAccent)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
${head}<style>${CSS}</style>
</head>
<body>
${body}${script ? `<script>${REFRESH_SCRIPT}</script>\n` : ''}</body>
</html>
`;
}

function bar(entry: {
  day: string;
  status: BarStatus;
  availability: number | null;
  downSec: number;
}): string {
  const day = formatDayText(`${entry.day}T00:00:00Z`);
  let text = `${day}: no data`;
  if (entry.status === 'maintenance') text = `${day}: maintenance`;
  else if (entry.availability !== null) {
    text =
      entry.status === 'up'
        ? `${day}: no downtime`
        : `${day}: ${formatAvailability(entry.availability)} uptime, ${formatDuration(entry.downSec)} down`;
  }
  return `<i class="${entry.status}" title="${escapeHtml(text)}"></i>`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

function componentHtml(component: PublicComponent, days: number): string {
  const uptime =
    component.uptime === null
      ? 'no data yet'
      : `${formatAvailability(component.uptime)} uptime`;
  return `<div class="comp t-${component.status}">
<div class="row"><span class="label">${escapeHtml(component.label)}</span><span class="badge">${ICONS[component.status]}${escapeHtml(STATUS_LABELS[component.status])}</span></div>
<div class="bars" role="img" aria-label="${escapeHtml(`${component.label}: ${uptime} over the last ${days} days`)}">${component.bars.map(bar).join('')}</div>
<div class="scale"><span>${days} days ago</span><span>${escapeHtml(uptime)}</span><span>Today</span></div>
</div>`;
}

function componentsHtml(components: PublicComponent[], days: number): string {
  if (components.length === 0)
    return '<p class="empty">No components have been added to this page yet.</p>';
  const groups: { name: string; items: PublicComponent[] }[] = [];
  for (const component of components) {
    let group = groups.find((entry) => entry.name === component.group);
    if (!group) {
      group = { name: component.group, items: [] };
      groups.push(group);
    }
    group.items.push(component);
  }
  return groups
    .map(
      (group) =>
        `<section class="group">${group.name ? `<h3>${escapeHtml(group.name)}</h3>` : ''}<div class="card" style="padding:0">${group.items.map((item) => componentHtml(item, days)).join('')}</div></section>`,
    )
    .join('\n');
}

function incidentHtml(incident: PublicIncident): string {
  const impact =
    incident.impact === 'degraded' ? 'Degraded performance' : 'Outage';
  const tone = incident.impact === 'degraded' ? 'degraded' : 'outage';
  const affects =
    incident.components.length > 0
      ? `Affects ${incident.components.map(escapeHtml).join(', ')}. `
      : '';
  const span = incident.resolvedAt
    ? `Started ${timeTag(incident.startedAt)}, resolved ${timeTag(incident.resolvedAt)}`
    : `Started ${timeTag(incident.startedAt)}`;
  const updates = incident.updates
    .map(
      (update) =>
        `<li><strong>${escapeHtml(STATE_LABELS[update.state])}</strong>${timeTag(update.at)}<p>${paragraphs(update.message)}</p></li>`,
    )
    .join('');
  return `<article class="card inc" id="i-${escapeHtml(incident.id)}">
<h3>${escapeHtml(incident.title)}<span class="chip t-${tone}">${impact}</span></h3>
<p class="meta">${affects}${span}.</p>
<ol class="timeline">${updates}</ol>
</article>`;
}

function maintenanceHtml(item: PublicMaintenance): string {
  const start = new Date(item.startsAt);
  const end = new Date(item.endsAt);
  const sameDay =
    start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
  const range = sameDay
    ? `${formatTimeText(item.startsAt)} to ${hourFormat.format(end)} UTC`
    : `${formatTimeText(item.startsAt)} to ${formatTimeText(item.endsAt)}`;
  const affects =
    item.components.length > 0
      ? `Affects ${item.components.map(escapeHtml).join(', ')}.`
      : '';
  return `<article class="card inc t-maintenance">
<h3>${escapeHtml(item.name)}<span class="chip">${item.active ? 'In progress' : 'Scheduled'}</span></h3>
<p class="meta" style="margin:0"><time datetime="${escapeHtml(item.startsAt)}">${escapeHtml(range)}</time>. ${affects}</p>
</article>`;
}

function pastHtml(past: PublicIncident[]): string {
  if (past.length === 0)
    return '<p class="empty">No incidents in the last 14 days.</p>';
  const days: { day: string; items: PublicIncident[] }[] = [];
  for (const incident of past) {
    const day = incident.startedAt.slice(0, 10);
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push(incident);
    else days.push({ day, items: [incident] });
  }
  return days
    .map(
      (entry) =>
        `<div class="day">${escapeHtml(formatDayText(`${entry.day}T00:00:00Z`))}</div>${entry.items.map(incidentHtml).join('\n')}`,
    )
    .join('\n');
}

export function renderStatusPage(
  model: PublicStatus,
  context: RenderContext,
): string {
  const { page } = model;
  const head = `<meta name="description" content="${escapeHtml(`Current status of ${page.name}`)}">
<link rel="alternate" type="application/rss+xml" title="${escapeHtml(`${page.name} status`)}" href="${escapeHtml(`${context.base}/rss.xml`)}">
`;
  const logo = page.logoUrl
    ? `<img src="${escapeHtml(page.logoUrl)}" alt="" height="40">`
    : '';
  const visit = page.websiteUrl
    ? `<a class="visit" href="${escapeHtml(page.websiteUrl)}" rel="noopener noreferrer">Visit website</a>`
    : '';
  const tone: ComponentStatus = OVERALL_ICON[model.overall.status];
  const body = `<main>
<header class="top">${logo}<div class="name"><h1>${escapeHtml(page.name)}</h1>${page.headline ? `<p class="headline">${escapeHtml(page.headline)}</p>` : ''}</div>${visit}</header>
<div class="banner t-${model.overall.status}" role="status">${ICONS[tone]}<span>${escapeHtml(model.overall.label)}</span></div>
${model.active.length > 0 ? `<h2>Current incidents</h2>\n${model.active.map(incidentHtml).join('\n')}` : ''}
${model.maintenance.length > 0 ? `<h2>Scheduled maintenance</h2>\n${model.maintenance.map(maintenanceHtml).join('\n')}` : ''}
<h2>Components</h2>
${componentsHtml(model.components, page.historyDays)}
<h2>Past incidents</h2>
${pastHtml(model.past)}
<h2>Get updates</h2>
<div class="card">
<p style="margin:0">Get an email when an incident is created, updated or resolved.</p>
<form class="sub" method="post" action="${escapeHtml(`${context.base}/subscribe`)}">
<label class="sr" for="subscribe-email">Email address</label>
<input id="subscribe-email" type="email" name="email" required maxlength="254" autocomplete="email" placeholder="you@example.com">
<input class="hp" type="text" name="company_url" tabindex="-1" autocomplete="off" aria-hidden="true">
<button class="btn" type="submit">Subscribe</button>
</form>
<p class="small"><a href="${escapeHtml(`${context.base}/rss.xml`)}">RSS feed</a> &middot; <a href="${escapeHtml(`${context.base}/summary.json`)}">JSON</a></p>
</div>
</main>
<footer>${page.footer ? `<div>${paragraphs(page.footer)}</div>` : ''}<div>Times are in UTC. Powered by Infra Sentinel.</div></footer>
`;
  return documentShell(
    page,
    `${page.name} Status: ${model.overall.label}`,
    head,
    body,
    true,
  );
}

export function renderMessagePage(options: MessageOptions): string {
  const form = options.form
    ? `<form method="post" action="${escapeHtml(options.form.action)}"><input type="hidden" name="token" value="${escapeHtml(options.form.token)}"><button class="btn" type="submit">${escapeHtml(options.form.button)}</button></form>`
    : '';
  const back =
    options.back === false
      ? ''
      : `<p class="small"><a href="${escapeHtml(options.base === '' ? '/' : options.base)}">Back to the status page</a></p>`;
  const body = `<main><div class="msg"><h1>${escapeHtml(options.title)}</h1><p>${paragraphs(options.message)}</p>${form}${back}</div></main>
`;
  return documentShell(
    options.page,
    options.page ? `${options.page.name} Status` : 'Status page',
    '<meta name="robots" content="noindex">\n',
    body,
    false,
  );
}

function xml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderRss(model: PublicStatus, context: RenderContext): string {
  const items = [...model.active, ...model.past]
    .sort(
      (a, b) =>
        Date.parse(b.updates[0]?.at ?? b.startedAt) -
        Date.parse(a.updates[0]?.at ?? a.startedAt),
    )
    .slice(0, 30)
    .map((incident) => {
      const latest = incident.updates[0];
      const description = incident.updates
        .map(
          (update) =>
            `${STATE_LABELS[update.state]} (${formatTimeText(update.at)}): ${update.message}`,
        )
        .join('\n\n');
      return `<item>
<title>${xml(`${incident.state === 'resolved' ? 'Resolved: ' : ''}${incident.title}`)}</title>
<link>${xml(`${context.publicUrl}#i-${incident.id}`)}</link>
<guid isPermaLink="false">${xml(`${incident.id}:${latest ? latest.at : incident.startedAt}`)}</guid>
<pubDate>${new Date(latest ? latest.at : incident.startedAt).toUTCString()}</pubDate>
<description>${xml(description)}</description>
</item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${xml(`${model.page.name} status`)}</title>
<link>${xml(context.publicUrl)}</link>
<description>${xml(`Incidents and status updates for ${model.page.name}. ${model.overall.label}.`)}</description>
<language>en</language>
<lastBuildDate>${new Date(model.generatedAt).toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>
`;
}

const INDICATOR: Record<OverallStatus, string> = {
  operational: 'none',
  degraded: 'minor',
  partial: 'major',
  major: 'critical',
  maintenance: 'maintenance',
  unknown: 'unknown',
  empty: 'none',
};

export function summaryJson(
  model: PublicStatus,
  context: RenderContext,
): Record<string, unknown> {
  const incident = (item: PublicIncident) => ({
    id: item.id,
    name: item.title,
    status: item.state,
    impact: item.impact,
    started_at: item.startedAt,
    resolved_at: item.resolvedAt,
    components: item.components,
    updates: item.updates.map((update) => ({
      status: update.state,
      body: update.message,
      created_at: update.at,
    })),
  });
  return {
    page: {
      name: model.page.name,
      url: context.publicUrl,
      updated_at: model.generatedAt,
    },
    status: {
      indicator: INDICATOR[model.overall.status],
      description: model.overall.label,
    },
    components: model.components.map((component) => ({
      name: component.label,
      group: component.group || null,
      status: component.status,
      uptime: component.uptime,
    })),
    incidents: model.active.map(incident),
    recent_incidents: model.past.map(incident),
    scheduled_maintenances: model.maintenance.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.active ? 'in_progress' : 'scheduled',
      scheduled_for: item.startsAt,
      scheduled_until: item.endsAt,
      components: item.components,
    })),
  };
}
