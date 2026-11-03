import {
  barStatus,
  hostOf,
  impactOf,
  isIpLiteral,
  monitorComponentStatus,
  normalizeDomain,
  overallStatus,
  ownHosts,
  publicIncidentId,
  publicState,
  publicTimeline,
  serverComponentStatus,
  slugify,
  suggestedTitle,
  verificationRecord,
} from './status.model';
import {
  componentsSchema,
  createPageSchema,
  incidentStatusSchema,
  patchPageSchema,
  subscribeSchema,
  updateSchema,
} from './status.schema';

describe('component and overall status', () => {
  it('maps monitors and servers', () => {
    expect(monitorComponentStatus('up', false)).toBe('operational');
    expect(monitorComponentStatus('degraded', false)).toBe('degraded');
    expect(monitorComponentStatus('down', false)).toBe('outage');
    expect(monitorComponentStatus('pending', false)).toBe('unknown');
    expect(monitorComponentStatus('up', true)).toBe('unknown');
    expect(serverComponentStatus('online')).toBe('operational');
    expect(serverComponentStatus('offline')).toBe('outage');
    expect(serverComponentStatus('pending')).toBe('unknown');
  });

  it('summarises a page', () => {
    expect(overallStatus([])).toBe('empty');
    expect(overallStatus(['operational', 'operational'])).toBe('operational');
    expect(overallStatus(['operational', 'unknown'])).toBe('operational');
    expect(overallStatus(['unknown', 'unknown'])).toBe('unknown');
    expect(overallStatus(['operational', 'degraded'])).toBe('degraded');
    expect(overallStatus(['operational', 'maintenance'])).toBe('maintenance');
    expect(overallStatus(['operational', 'outage'])).toBe('partial');
    expect(overallStatus(['outage', 'outage'])).toBe('major');
    expect(overallStatus(['degraded', 'outage', 'maintenance'])).toBe(
      'partial',
    );
  });

  it('colours day bars', () => {
    expect(barStatus(1, 0)).toBe('up');
    expect(barStatus(0.9996, 0)).toBe('up');
    expect(barStatus(0.995, 0)).toBe('minor');
    expect(barStatus(0.98, 0)).toBe('major');
    expect(barStatus(null, 0)).toBe('none');
    expect(barStatus(null, 3600)).toBe('maintenance');
  });
});

describe('incident presentation', () => {
  it('works out impact and generic titles', () => {
    expect(impactOf('monitor', 'down')).toBe('outage');
    expect(impactOf('monitor', 'degraded')).toBe('degraded');
    expect(impactOf('server', 'down')).toBe('outage');
    expect(suggestedTitle('Checkout API', 'outage')).toBe(
      'Checkout API is unavailable',
    );
    expect(suggestedTitle('Checkout API', 'degraded')).toBe(
      'Checkout API is experiencing degraded performance',
    );
  });

  it('gives each page its own opaque id for an incident', () => {
    const a = publicIncidentId('page-1', 'incident-1');
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(publicIncidentId('page-1', 'incident-1')).toBe(a);
    expect(publicIncidentId('page-2', 'incident-1')).not.toBe(a);
  });

  it('derives the public state', () => {
    expect(publicState(false, [])).toBe('investigating');
    expect(
      publicState(false, [{ state: 'identified', message: 'x', at: 1 }]),
    ).toBe('identified');
    expect(
      publicState(false, [
        { state: 'monitoring', message: 'x', at: 1 },
        { state: 'resolved', message: 'y', at: 2 },
      ]),
    ).toBe('monitoring');
    expect(
      publicState(true, [{ state: 'identified', message: 'x', at: 1 }]),
    ).toBe('resolved');
  });

  it('builds a newest-first timeline with generated first and last lines', () => {
    const timeline = publicTimeline(
      1000,
      5000,
      ['API'],
      [{ state: 'identified', message: 'Found it', at: 2000 }],
    );
    expect(timeline.map((item) => item.state)).toEqual([
      'resolved',
      'identified',
      'investigating',
    ]);
    expect(timeline[2].message).toBe(
      'We detected a problem with API and are looking into it.',
    );
    expect(timeline[0].message).toBe('This incident has been resolved.');
    expect(timeline[0].at).toBe(new Date(5000).toISOString());
  });

  it('does not add a second resolved line when one was posted', () => {
    const timeline = publicTimeline(
      1000,
      5000,
      ['API'],
      [{ state: 'resolved', message: 'Fixed by rollback', at: 5200 }],
    );
    expect(timeline.map((item) => item.message)).toEqual([
      'Fixed by rollback',
      'We detected a problem with API and are looking into it.',
    ]);
  });

  it('keeps open incidents without a resolved line', () => {
    expect(
      publicTimeline(1000, null, [], []).map((item) => item.state),
    ).toEqual(['investigating']);
    expect(publicTimeline(1000, null, [], [])[0].message).toContain(
      'this service',
    );
  });
});

describe('domains and hosts', () => {
  it('normalises custom domains', () => {
    expect(normalizeDomain('Status.Example.com')).toBe('status.example.com');
    expect(normalizeDomain('https://status.example.com/path?x=1')).toBe(
      'status.example.com',
    );
    expect(normalizeDomain(' status.example.com. ')).toBe('status.example.com');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('status')).toBeNull();
    expect(normalizeDomain('a_b.example.com')).toBeNull();
    expect(normalizeDomain('-bad.example.com')).toBeNull();
    expect(normalizeDomain('example.123')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('a'.repeat(64) + '.example.com')).toBeNull();
    expect(normalizeDomain('status.xn--p1ai')).toBe('status.xn--p1ai');
  });

  it('reads the host header', () => {
    expect(hostOf('Status.Example.com:443')).toBe('status.example.com');
    expect(hostOf('status.example.com')).toBe('status.example.com');
    expect(hostOf('[::1]:4000')).toBe('::1');
    expect(hostOf('::1')).toBe('::1');
    expect(hostOf(undefined)).toBe('');
    expect(isIpLiteral('10.0.0.5')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });

  it('lists own hosts', () => {
    const hosts = ownHosts(
      'https://monitor.example.com',
      'http://localhost:4000',
      'not a url',
    );
    expect(hosts.has('monitor.example.com')).toBe(true);
    expect(hosts.has('localhost')).toBe(true);
    expect(hosts.has('status.example.com')).toBe(false);
  });

  it('builds the DNS record', () => {
    expect(verificationRecord('status.example.com', 'abc')).toEqual({
      name: '_sentinel-verify.status.example.com',
      value: 'sentinel-verify=abc',
    });
  });

  it('makes slugs', () => {
    expect(slugify('Acme Cloud Status')).toBe('acme-cloud-status');
    expect(slugify('  Café --- Ünïcode  ')).toBe('cafe-unicode');
    expect(slugify('A')).toBe('');
    expect(slugify('!!!')).toBe('');
    expect(slugify('x'.repeat(60)).length).toBe(40);
  });
});

describe('status schemas', () => {
  it('validates pages', () => {
    expect(createPageSchema.safeParse({ name: 'Acme' }).success).toBe(true);
    expect(
      createPageSchema.safeParse({ name: 'Acme', slug: 'Acme-Status' }).success,
    ).toBe(true);
    expect(
      createPageSchema.safeParse({ name: 'Acme', slug: 'a' }).success,
    ).toBe(false);
    expect(
      createPageSchema.safeParse({ name: 'Acme', slug: '-bad-' }).success,
    ).toBe(false);
    expect(createPageSchema.safeParse({ name: '' }).success).toBe(false);
    expect(createPageSchema.safeParse({ name: 'x', extra: 1 }).success).toBe(
      false,
    );
    expect(
      patchPageSchema.safeParse({ websiteUrl: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      patchPageSchema.safeParse({ websiteUrl: 'https://acme.test' }).success,
    ).toBe(true);
    expect(patchPageSchema.safeParse({ logoUrl: '' }).success).toBe(true);
    expect(patchPageSchema.safeParse({ accent: '#ABCDEF' }).data).toEqual({
      accent: '#abcdef',
    });
    expect(patchPageSchema.safeParse({ accent: 'red' }).success).toBe(false);
    expect(patchPageSchema.safeParse({ historyDays: 120 }).success).toBe(false);
    expect(patchPageSchema.safeParse({ theme: 'sepia' }).success).toBe(false);
  });

  it('validates components, updates and subscribers', () => {
    const id = '3f2b9c1e-8d4a-4f6b-9a1c-2e7d5b8a0c11';
    expect(
      componentsSchema.safeParse({ components: [{ kind: 'monitor', id }] })
        .success,
    ).toBe(true);
    expect(
      componentsSchema.safeParse({ components: [{ kind: 'dns', id }] }).success,
    ).toBe(false);
    expect(
      componentsSchema.safeParse({
        components: [{ kind: 'monitor', id: 'nope' }],
      }).success,
    ).toBe(false);
    expect(
      updateSchema.safeParse({ state: 'identified', message: ' We found it ' })
        .data,
    ).toEqual({ state: 'identified', message: 'We found it' });
    expect(
      updateSchema.safeParse({ state: 'identified', message: '  ' }).success,
    ).toBe(false);
    expect(
      updateSchema.safeParse({ state: 'weird', message: 'x' }).success,
    ).toBe(false);
    expect(incidentStatusSchema.safeParse({}).success).toBe(false);
    expect(incidentStatusSchema.safeParse({ hidden: true }).success).toBe(true);
    expect(
      subscribeSchema.safeParse({ email: ' Ann@Example.COM ' }).data,
    ).toEqual({ email: 'ann@example.com' });
    expect(subscribeSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });
});
