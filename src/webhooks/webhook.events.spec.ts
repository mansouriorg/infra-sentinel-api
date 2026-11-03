import {
  AUTO_DISABLE_AFTER,
  WEBHOOK_EVENTS,
  backoffSeconds,
  checkWebhookUrl,
  createWebhookSchema,
  deliveryQuerySchema,
  envelope,
  eventTypeFor,
  newSecret,
  scrubTarget,
  signature,
  updateWebhookSchema,
  verifySignature,
} from './webhook.events';

describe('webhook events', () => {
  it('maps what happens inside the app to event names', () => {
    expect(
      eventTypeFor({
        type: 'status',
        monitorId: 'm',
        name: 'x',
        from: 'up',
        to: 'down',
        kind: 'down',
        message: '',
        at: '',
      }),
    ).toBe('monitor.status_changed');
    expect(
      eventTypeFor({ type: 'monitor', monitorId: 'm', change: 'created' }),
    ).toBe('monitor.created');
    expect(
      eventTypeFor({ type: 'monitor', monitorId: 'm', change: 'updated' }),
    ).toBe('monitor.updated');
    expect(
      eventTypeFor({ type: 'monitor', monitorId: 'm', change: 'deleted' }),
    ).toBe('monitor.deleted');
    expect(
      eventTypeFor({
        type: 'incident',
        incidentId: 'i',
        number: 1,
        change: 'opened',
      }),
    ).toBe('incident.opened');
    expect(
      eventTypeFor({
        type: 'incident',
        incidentId: 'i',
        number: 1,
        change: 'updated',
      }),
    ).toBe('incident.updated');
    expect(
      eventTypeFor({
        type: 'incident',
        incidentId: 'i',
        number: 1,
        change: 'resolved',
      }),
    ).toBe('incident.resolved');
    expect(
      eventTypeFor({ type: 'server', serverId: 's', change: 'status' }),
    ).toBe('server.status_changed');
    expect(
      eventTypeFor({ type: 'server', serverId: 's', change: 'created' }),
    ).toBe('server.created');
    expect(
      eventTypeFor({ type: 'server', serverId: 's', change: 'deleted' }),
    ).toBe('server.deleted');
    expect(
      eventTypeFor({ type: 'server', serverId: 's', change: 'updated' }),
    ).toBeNull();
    expect(
      eventTypeFor({
        type: 'check',
        monitorId: 'm',
        status: 'up',
        checkStatus: 'up',
        responseMs: 1,
        message: '',
        at: '',
      }),
    ).toBeNull();
  });

  it('only offers events that something can send', () => {
    const ids = WEBHOOK_EVENTS.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it('signs a body so the receiver can check it', () => {
    const header = signature('whsec_test', '{"a":1}', 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(signature('whsec_test', '{"a":1}', 1_700_000_000)).toBe(header);
    expect(
      verifySignature('whsec_test', header, '{"a":1}', 1_700_000_100),
    ).toBe(true);
    expect(
      verifySignature('whsec_test', header, '{"a":2}', 1_700_000_100),
    ).toBe(false);
    expect(
      verifySignature('whsec_other', header, '{"a":1}', 1_700_000_100),
    ).toBe(false);
    expect(
      verifySignature('whsec_test', header, '{"a":1}', 1_700_001_000),
    ).toBe(false);
    expect(
      verifySignature('whsec_test', undefined, '{"a":1}', 1_700_000_100),
    ).toBe(false);
    expect(
      verifySignature('whsec_test', 'garbage', '{"a":1}', 1_700_000_100),
    ).toBe(false);
    expect(
      verifySignature('whsec_test', 't=abc,v1=ff', '{"a":1}', 1_700_000_100),
    ).toBe(false);
  });

  it('retries on a widening schedule and gives up after the last one', () => {
    expect([1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([
      30, 120, 600, 3600, 21_600,
    ]);
    expect(backoffSeconds(99)).toBe(21_600);
    expect(backoffSeconds(0)).toBe(30);
    expect(AUTO_DISABLE_AFTER).toBe(20);
  });

  it('makes a long random secret', () => {
    const secret = newSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(newSecret()).not.toBe(secret);
  });

  it('wraps data in an envelope', () => {
    const made = envelope('e1', 'test.ping', 'org1', { hello: 'world' }, 0);
    expect(made).toEqual({
      id: 'e1',
      type: 'test.ping',
      createdAt: '1970-01-01T00:00:00.000Z',
      organizationId: 'org1',
      data: { hello: 'world' },
    });
  });

  it('removes logins and queries from monitor targets before they leave the building', () => {
    expect(scrubTarget('https://user:pw@example.com/path?token=abc#x')).toBe(
      'https://example.com/path',
    );
    expect(scrubTarget('https://example.com/')).toBe('https://example.com');
    expect(scrubTarget('db.internal:5432')).toBe('db.internal:5432');
    expect(scrubTarget('http://')).toBe('http://');
  });

  it('checks addresses', () => {
    expect(checkWebhookUrl('https://example.com/hook', true)).toBeNull();
    expect(checkWebhookUrl('http://localhost:9000/hook', false)).toBeNull();
    expect(checkWebhookUrl('http://example.com/hook', true)).toMatch(/https/);
    expect(checkWebhookUrl('ftp://example.com', false)).toMatch(
      /https:\/\/ or http/,
    );
    expect(checkWebhookUrl('not a url', false)).toMatch(/full address/);
    expect(checkWebhookUrl('https://me:secret@example.com', false)).toMatch(
      /user name/,
    );
    expect(checkWebhookUrl('https://example.com/#frag', false)).toMatch(/#/);
  });

  it('validates what an admin can send', () => {
    const ok = createWebhookSchema.parse({
      name: ' Chat ',
      url: ' https://example.com/x ',
      events: ['incident.resolved', 'incident.opened', 'incident.opened'],
    });
    expect(ok).toEqual({
      name: 'Chat',
      url: 'https://example.com/x',
      events: ['incident.opened', 'incident.resolved'],
    });
    expect(
      createWebhookSchema.safeParse({
        name: '',
        url: 'x',
        events: ['incident.opened'],
      }).success,
    ).toBe(false);
    expect(
      createWebhookSchema.safeParse({ name: 'a', url: 'x', events: [] })
        .success,
    ).toBe(false);
    expect(
      createWebhookSchema.safeParse({ name: 'a', url: 'x', events: ['nope'] })
        .success,
    ).toBe(false);
    expect(
      createWebhookSchema.safeParse({
        name: 'a',
        url: 'x',
        events: ['test.ping'],
      }).success,
    ).toBe(false);
    expect(updateWebhookSchema.safeParse({}).success).toBe(false);
    expect(updateWebhookSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(deliveryQuerySchema.parse({}).limit).toBe(30);
    const blank = deliveryQuerySchema.parse({ status: '', before: '' });
    expect(blank.status).toBeUndefined();
    expect(blank.before).toBeUndefined();
    expect(deliveryQuerySchema.safeParse({ status: 'weird' }).success).toBe(
      false,
    );
    expect(deliveryQuerySchema.safeParse({ before: 'yesterday' }).success).toBe(
      false,
    );
  });
});
