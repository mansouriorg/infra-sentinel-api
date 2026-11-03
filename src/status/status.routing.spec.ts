import { createStatusRouting, type StatusRequest } from './status.routing';

function run(
  url: string,
  host: string | undefined,
  verified: Record<string, string> = {},
) {
  const calls: string[] = [];
  const lookups: string[] = [];
  const own = new Set(['monitor.example.com', 'localhost']);
  const middleware = createStatusRouting(
    {
      isOwnHost: (value: string) =>
        value === '' || own.has(value) || /^\d+\.\d+\.\d+\.\d+$/.test(value),
      lookup: async (value: string) => {
        lookups.push(value);
        return verified[value] ?? null;
      },
    },
    'api/v1',
  );
  const request = { url, headers: { host } } as unknown as StatusRequest;
  const sent: { code?: number; body?: string; type?: string } = {};
  const response: any = {
    status(code: number) {
      sent.code = code;
      return this;
    },
    type(value: string) {
      sent.type = value;
      return this;
    },
    send(body: string) {
      sent.body = body;
      return this;
    },
    end() {
      sent.body = '';
    },
  };
  return new Promise<{
    request: StatusRequest;
    passed: boolean;
    sent: typeof sent;
    lookups: string[];
    calls: string[];
  }>((resolve) => {
    let passed = false;
    middleware(request, response, () => {
      passed = true;
    });
    setTimeout(() => resolve({ request, passed, sent, lookups, calls }), 5);
  });
}

describe('status routing', () => {
  it('rewrites /status/:slug on any host', async () => {
    const result = await run('/status/acme/rss.xml?x=1', 'monitor.example.com');
    expect(result.passed).toBe(true);
    expect(result.request.url).toBe('/api/v1/public/status/acme/rss.xml?x=1');
    expect(result.request.statusBase).toBe('/status/acme');
    expect(result.lookups).toEqual([]);
    const root = await run('/status/acme', 'localhost:3000');
    expect(root.request.url).toBe('/api/v1/public/status/acme');
  });

  it('leaves other paths on own hosts alone', async () => {
    const result = await run('/api/v1/auth/me', 'monitor.example.com:443');
    expect(result.passed).toBe(true);
    expect(result.request.url).toBe('/api/v1/auth/me');
    expect(result.lookups).toEqual([]);
    expect((await run('/status', 'localhost')).request.url).toBe('/status');
    expect((await run('/status/A', 'localhost')).request.url).toBe('/status/A');
  });

  it('serves a verified custom domain as the page root', async () => {
    const verified = { 'status.acme.test': 'acme' };
    const root = await run('/', 'Status.Acme.test', verified);
    expect(root.passed).toBe(true);
    expect(root.request.url).toBe('/api/v1/public/status/acme');
    expect(root.request.statusBase).toBe('');
    const rss = await run('/rss.xml', 'status.acme.test', verified);
    expect(rss.request.url).toBe('/api/v1/public/status/acme/rss.xml');
    const unsub = await run(
      '/unsubscribe?token=abc',
      'status.acme.test',
      verified,
    );
    expect(unsub.request.url).toBe(
      '/api/v1/public/status/acme/unsubscribe?token=abc',
    );
  });

  it('blocks everything else on a custom domain', async () => {
    const verified = { 'status.acme.test': 'acme' };
    for (const path of [
      '/api/v1/auth/me',
      '/docs',
      '/status/other',
      '/api/v1/public/status/other',
    ]) {
      const result = await run(path, 'status.acme.test', verified);
      if (path === '/status/other') {
        expect(result.request.url).toBe('/api/v1/public/status/other');
        continue;
      }
      expect(result.passed).toBe(false);
      expect(result.sent.code).toBe(404);
    }
    const icon = await run('/favicon.ico', 'status.acme.test', verified);
    expect(icon.sent.code).toBe(204);
  });

  it('passes unknown hosts through untouched', async () => {
    const result = await run('/api/v1/health', 'api:4000');
    expect(result.passed).toBe(true);
    expect(result.request.url).toBe('/api/v1/health');
    expect(result.lookups).toEqual(['api']);
    expect((await run('/', undefined)).passed).toBe(true);
  });
});
