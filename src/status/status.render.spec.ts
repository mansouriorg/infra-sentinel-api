import { createHash } from 'node:crypto';
import { assembleStatus } from './status.assemble';
import {
  PAGE_CSP,
  readableOn,
  renderMessagePage,
  renderRss,
  renderStatusPage,
  summaryJson,
} from './status.render';
import type { PublicPageInfo } from './status.types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

const page: PublicPageInfo = {
  slug: 'acme',
  name: 'Acme <b>Cloud</b> & Co',
  headline: 'We "ship" things',
  websiteUrl: 'https://acme.test/?a=1&b=2',
  logoUrl: 'https://acme.test/logo.png',
  accent: '#0e7490',
  theme: 'auto',
  footer: 'Line one\nLine <two>',
  historyDays: 90,
};

function model() {
  return assembleStatus({
    pageId: 'p1',
    page,
    now: NOW,
    components: [
      {
        kind: 'monitor',
        subjectId: 'm1',
        label: 'API <script>alert(1)</script>',
        group: 'Core',
        position: 0,
        tags: [],
        createdAt: NOW - 200 * DAY,
        status: 'outage',
        paused: [],
      },
      {
        kind: 'monitor',
        subjectId: 'm2',
        label: 'Website',
        group: 'Core',
        position: 1,
        tags: [],
        createdAt: NOW - 200 * DAY,
        status: 'operational',
        paused: [],
      },
      {
        kind: 'server',
        subjectId: 's1',
        label: 'Database host',
        group: '',
        position: 2,
        tags: [],
        createdAt: NOW - 200 * DAY,
        status: 'operational',
        paused: [],
      },
    ],
    incidents: [
      {
        id: 'i1',
        kind: 'monitor',
        subjectId: 'm1',
        trigger: 'down',
        resolved: false,
        startedAt: NOW - HOUR,
        resolvedAt: null,
        publicTitle: 'Payments "down" <img src=x onerror=alert(1)>',
      },
      {
        id: 'i2',
        kind: 'monitor',
        subjectId: 'm2',
        trigger: 'down',
        resolved: true,
        startedAt: NOW - 3 * DAY,
        resolvedAt: NOW - 3 * DAY + HOUR,
        publicTitle: '',
      },
    ],
    updates: [
      {
        incidentId: 'i1',
        state: 'identified',
        message: 'Found it\nRolling back <b>now</b>',
        at: NOW - 30 * 60_000,
      },
    ],
    windows: [
      {
        id: 'w1',
        name: 'DB upgrade & reindex',
        spec: {
          startsAt: new Date(NOW + 2 * DAY),
          durationSec: 3600,
          repeat: 'none',
        },
        scope: { all: true, monitorIds: [], tags: [] },
      },
    ],
  });
}

const context = {
  base: '/status/acme',
  publicUrl: 'https://monitor.example.com/status/acme',
};

describe('renderStatusPage', () => {
  const html = renderStatusPage(model(), context);

  it('escapes everything an operator can type', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Cloud</b>');
    expect(html).not.toContain('Line <two>');
    expect(html).toContain('Acme &lt;b&gt;Cloud&lt;/b&gt; &amp; Co');
    expect(html).toContain(
      'Payments &quot;down&quot; &lt;img src=x onerror=alert(1)&gt;',
    );
    expect(html).toContain('Rolling back &lt;b&gt;now&lt;/b&gt;');
    expect(html).toContain('Line one<br>Line &lt;two&gt;');
    expect(html).toContain('href="https://acme.test/?a=1&amp;b=2"');
  });

  it('shows the banner, components, incidents, maintenance and form', () => {
    expect(html).toContain('Partial outage');
    expect(html).toContain('Current incidents');
    expect(html).toContain('Identified');
    expect(html).toContain('Scheduled maintenance');
    expect(html).toContain('DB upgrade &amp; reindex');
    expect(html).toContain('Past incidents');
    expect(html).toContain('Website is unavailable');
    expect(html).toContain('action="/status/acme/subscribe"');
    expect(html).toContain('href="/status/acme/rss.xml"');
    expect(html).toContain('name="company_url"');
    expect((html.match(/<i class="/g) ?? []).length).toBe(90 * 3);
  });

  it('allows exactly one inline script and the CSP matches its hash', () => {
    const scripts = html.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
    expect(scripts.length).toBe(1);
    const body = (scripts[0] as string)
      .replace('<script>', '')
      .replace('</script>', '');
    const hash = createHash('sha256').update(body).digest('base64');
    expect(PAGE_CSP).toContain(`'sha256-${hash}'`);
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).toContain("frame-ancestors 'none'");
  });

  it('sets the theme and a readable button color', () => {
    expect(html).toContain('data-theme="auto"');
    expect(html).toContain('--accent:#0e7490');
    expect(html).toContain('--on-accent:#ffffff');
    expect(readableOn('#ffee00')).toBe('#0b1118');
    expect(readableOn('#000000')).toBe('#ffffff');
    expect(readableOn('nonsense')).toBe('#ffffff');
  });

  it('renders an empty page', () => {
    const empty = renderStatusPage(
      assembleStatus({
        pageId: 'p',
        page,
        now: NOW,
        components: [],
        incidents: [],
        updates: [],
        windows: [],
      }),
      context,
    );
    expect(empty).toContain('No components to show yet');
    expect(empty).toContain('No incidents in the last 14 days.');
  });

  it('uses root-relative links on a custom domain', () => {
    const custom = renderStatusPage(model(), {
      base: '',
      publicUrl: 'https://status.acme.test',
    });
    expect(custom).toContain('action="/subscribe"');
    expect(custom).toContain('href="/rss.xml"');
  });
});

describe('message page', () => {
  it('renders an unsubscribe confirmation form with the token', () => {
    const html = renderMessagePage({
      page,
      title: 'Unsubscribe',
      message: 'Stop emails?',
      base: '/status/acme',
      form: {
        action: '/status/acme/unsubscribe',
        token: 'abc_DEF-123',
        button: 'Unsubscribe',
      },
    });
    expect(html).toContain(
      '<form method="post" action="/status/acme/unsubscribe">',
    );
    expect(html).toContain('name="token" value="abc_DEF-123"');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain('<script');
  });

  it('works without a page', () => {
    const html = renderMessagePage({
      page: null,
      title: 'Page not found',
      message: 'Nope',
      base: '',
      back: false,
    });
    expect(html).toContain('Page not found');
    expect(html).not.toContain('Back to the status page');
  });
});

describe('feeds', () => {
  it('builds well-formed RSS with escaped content and stable guids', () => {
    const rss = renderRss(model(), context);
    expect(rss.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(rss).toContain(
      '<title>Acme &lt;b&gt;Cloud&lt;/b&gt; &amp; Co status</title>',
    );
    expect(rss).toContain(
      'Payments &quot;down&quot; &lt;img src=x onerror=alert(1)&gt;',
    );
    expect(rss).not.toContain('<img');
    expect((rss.match(/<item>/g) ?? []).length).toBe(2);
    expect(rss).toContain('<link>https://monitor.example.com/status/acme#i-');
    expect(rss).toContain('<guid isPermaLink="false">');
    expect(rss).toContain('Resolved: Website is unavailable');
  });

  it('summarises as JSON', () => {
    const json = summaryJson(model(), context) as any;
    expect(json.status).toEqual({
      indicator: 'major',
      description: 'Partial outage',
    });
    expect(json.page.url).toBe('https://monitor.example.com/status/acme');
    expect(
      json.components.map((item: any) => [item.name, item.status]),
    ).toEqual([
      ['API <script>alert(1)</script>', 'outage'],
      ['Website', 'operational'],
      ['Database host', 'operational'],
    ]);
    expect(json.incidents.length).toBe(1);
    expect(json.incidents[0].updates[0].status).toBe('identified');
    expect(json.recent_incidents.length).toBe(1);
    expect(json.scheduled_maintenances[0].status).toBe('scheduled');
    expect(JSON.stringify(json)).not.toContain('i1');
  });
});
