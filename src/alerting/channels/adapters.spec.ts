import { createHmac } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildMessage,
  testMessage,
  type IncidentContext,
} from '../alert.message';
import {
  deliver,
  signBody,
  webhookPayload,
  type DeliveryContext,
} from './adapters';

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const ctx: IncidentContext = {
  id: 'inc-1',
  number: 3,
  title: 'Storefront is down',
  severity: 'critical',
  status: 'open',
  trigger: 'down',
  startedAt: new Date('2026-10-24T10:00:00Z'),
  resolvedAt: null,
  cause: 'HTTP 503 <bad>',
  monitorId: 'm1',
  monitorName: 'Storefront',
  monitorTarget: 'https://shop.example.com',
  baseUrl: 'http://sentinel.local',
};

describe('channel adapters', () => {
  let server: http.Server;
  let base = '';
  let captured: Captured[] = [];
  let reply: { status: number; body: string } = { status: 200, body: 'ok' };
  const mails: { to: string; subject: string }[] = [];
  let mailFails: string[] = [];

  const context = (
    overrides: Partial<DeliveryContext> = {},
  ): DeliveryContext => ({
    blockPrivate: false,
    timeoutMs: 2000,
    sendMail: async (message) => {
      if (mailFails.includes(message.to)) throw new Error('mailbox full');
      mails.push({ to: message.to, subject: message.subject });
    },
    ...overrides,
  });

  const message = buildMessage('incident.opened', ctx);

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        captured.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.statusCode = reply.status;
        response.end(reply.body);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    captured = [];
    reply = { status: 200, body: 'ok' };
    mails.length = 0;
    mailFails = [];
  });

  it('posts a Slack attachment with the severity color', async () => {
    await deliver(
      'slack',
      { webhookUrl: `${base}/services/T/B/X` },
      message,
      context(),
    );
    const [request] = captured;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/services/T/B/X');
    const body = JSON.parse(request.body);
    expect(body.text).toContain('[CRITICAL] Storefront is down');
    expect(body.attachments[0].color).toBe('#dc2626');
    expect(body.attachments[0].title_link).toBe(
      'http://sentinel.local/incidents/inc-1',
    );
  });

  it('posts a Discord embed', async () => {
    reply = { status: 204, body: '' };
    await deliver(
      'discord',
      { webhookUrl: `${base}/api/webhooks/1/abc` },
      message,
      context(),
    );
    const body = JSON.parse(captured[0].body);
    expect(body.embeds[0].title).toBe('[CRITICAL] Storefront is down');
    expect(body.embeds[0].color).toBe(0xdc2626);
  });

  it('calls the Telegram Bot API with escaped HTML', async () => {
    reply = { status: 200, body: '{"ok":true}' };
    await deliver(
      'telegram',
      { botToken: '123456:ABCDEF-token', chatId: '-100500', apiBaseUrl: base },
      message,
      context(),
    );
    const [request] = captured;
    expect(request.url).toBe('/bot123456:ABCDEF-token/sendMessage');
    const body = JSON.parse(request.body);
    expect(body.chat_id).toBe('-100500');
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('<b>[CRITICAL] Storefront is down</b>');
    expect(body.text).toContain('HTTP 503 &lt;bad&gt;');
  });

  it('turns a Telegram error into a readable sentence', async () => {
    reply = {
      status: 400,
      body: '{"ok":false,"description":"Bad Request: chat not found"}',
    };
    await expect(
      deliver(
        'telegram',
        { botToken: '123456:ABCDEF-token', chatId: '1', apiBaseUrl: base },
        message,
        context(),
      ),
    ).rejects.toThrow(
      'Telegram answered HTTP 400: Bad Request: chat not found',
    );
  });

  it('publishes to ntfy as JSON with priority and token', async () => {
    await deliver(
      'ntfy',
      { serverUrl: base, topic: 'ops-alerts', token: 'tk_secret' },
      message,
      context(),
    );
    const [request] = captured;
    expect(request.url).toBe('/');
    expect(request.headers.authorization).toBe('Bearer tk_secret');
    const body = JSON.parse(request.body);
    expect(body.topic).toBe('ops-alerts');
    expect(body.priority).toBe(5);
    expect(body.tags).toEqual(['rotating_light']);
    expect(body.click).toBe('http://sentinel.local/incidents/inc-1');
  });

  it('sends to Gotify with the application token in a header', async () => {
    await deliver(
      'gotify',
      { serverUrl: base, appToken: 'AppTok' },
      message,
      context(),
    );
    const [request] = captured;
    expect(request.url).toBe('/message');
    expect(request.headers['x-gotify-key']).toBe('AppTok');
    expect(JSON.parse(request.body).priority).toBe(8);
  });

  it('signs generic webhooks and passes custom headers', async () => {
    await deliver(
      'webhook',
      { url: `${base}/hook`, headers: { 'X-Team': 'ops' }, secret: 's3cret' },
      message,
      context(),
    );
    const [request] = captured;
    expect(request.headers['x-team']).toBe('ops');
    expect(request.headers['x-sentinel-event']).toBe('incident.opened');
    const expected = `sha256=${createHmac('sha256', 's3cret').update(request.body).digest('hex')}`;
    expect(request.headers['x-sentinel-signature']).toBe(expected);
    const payload = JSON.parse(request.body);
    expect(payload.incident.number).toBe(3);
    expect(payload.monitor.name).toBe('Storefront');
    expect(payload.summary).toContain('Reason: HTTP 503 <bad>');
  });

  it('exposes helpers for signing and payloads', () => {
    expect(signBody('k', 'abc')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(webhookPayload(testMessage('http://x', 'n')).event).toBe('test');
  });

  it('sends one email per recipient and reports the ones that failed', async () => {
    await deliver(
      'email',
      { recipients: ['a@example.com', 'b@example.com'] },
      message,
      context(),
    );
    expect(mails.map((mail) => mail.to)).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    expect(mails[0].subject).toBe('[CRITICAL] Storefront is down');

    mailFails = ['b@example.com'];
    await expect(
      deliver(
        'email',
        { recipients: ['a@example.com', 'b@example.com'] },
        message,
        context(),
      ),
    ).rejects.toThrow('b@example.com: mailbox full');
  });

  it('reports HTTP errors with a snippet of the answer', async () => {
    reply = { status: 500, body: 'no_service' };
    await expect(
      deliver('slack', { webhookUrl: `${base}/x` }, message, context()),
    ).rejects.toThrow('Slack answered HTTP 500: no_service');
  });

  it('reports unreachable servers and private targets', async () => {
    await expect(
      deliver(
        'webhook',
        { url: 'http://127.0.0.1:1/hook', headers: {} },
        message,
        context(),
      ),
    ).rejects.toThrow('Connection refused');
    await expect(
      deliver(
        'webhook',
        { url: `${base}/hook`, headers: {} },
        message,
        context({ blockPrivate: true }),
      ),
    ).rejects.toThrow('private or local address');
  });

  it('gives up on slow servers', async () => {
    const slow = http.createServer(() => undefined);
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const port = (slow.address() as AddressInfo).port;
    try {
      await expect(
        deliver(
          'webhook',
          { url: `http://127.0.0.1:${port}/`, headers: {} },
          message,
          context({ timeoutMs: 300 }),
        ),
      ).rejects.toThrow('Timed out after 300 ms');
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});
