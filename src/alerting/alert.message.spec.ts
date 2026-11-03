import {
  buildMessage,
  plainText,
  renderEmail,
  testMessage,
  type IncidentContext,
} from './alert.message';

const ctx: IncidentContext = {
  id: 'abc',
  number: 7,
  title: 'Storefront is down',
  severity: 'critical',
  status: 'open',
  trigger: 'down',
  startedAt: new Date('2026-10-24T10:00:00Z'),
  resolvedAt: null,
  cause: 'HTTP 503, expected 200-299',
  monitorId: 'm1',
  monitorName: 'Storefront',
  monitorTarget: 'https://shop.example.com',
  baseUrl: 'http://localhost:3000/',
};

describe('alert messages', () => {
  it('describes a new incident', () => {
    const message = buildMessage('incident.opened', ctx);
    expect(message.title).toBe('[CRITICAL] Storefront is down');
    expect(message.url).toBe('http://localhost:3000/incidents/abc');
    expect(message.lines).toContain('Reason: HTTP 503, expected 200-299');
    expect(message.lines).toContain(
      'Monitor: Storefront (https://shop.example.com)',
    );
    expect(message.monitor?.id).toBe('m1');
  });

  it('says how long an escalated incident has gone unacknowledged', () => {
    const message = buildMessage(
      'incident.escalated',
      ctx,
      new Date('2026-10-24T10:15:00Z'),
    );
    expect(message.title).toBe('[ESCALATED CRITICAL] Storefront is down');
    expect(message.lines[0]).toContain('15m');
  });

  it('reports recovery with the duration', () => {
    const message = buildMessage('incident.resolved', {
      ...ctx,
      status: 'resolved',
      resolvedAt: new Date('2026-10-24T10:12:00Z'),
    });
    expect(message.title).toBe('[RESOLVED] Storefront is back up');
    expect(message.lines[0]).toContain('lasted 12m');
    expect(message.severity).toBe('info');
  });

  it('builds a test message and plain text', () => {
    const test = testMessage('http://localhost:3000', 'Ops chat');
    expect(test.event).toBe('test');
    expect(plainText(test)).toContain('Ops chat');
  });

  it('renders email with escaped content', () => {
    const message = buildMessage('incident.opened', {
      ...ctx,
      cause: '<script>alert(1)</script>',
    });
    const mail = renderEmail(message, 'ops@example.com');
    expect(mail.to).toBe('ops@example.com');
    expect(mail.subject).toBe('[CRITICAL] Storefront is down');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.text).toContain('http://localhost:3000/incidents/abc');
  });
});
