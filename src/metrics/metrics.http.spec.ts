import {
  bearerToken,
  createMetricsMiddleware,
  routeOf,
  type HttpRequest,
  type HttpResponse,
} from './metrics.http';
import type { MetricsService } from './metrics.service';

class FakeResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body: string | undefined;
  ended = false;
  private finish: (() => void)[] = [];

  on(_event: 'finish', listener: () => void) {
    this.finish.push(listener);
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value;
    return this;
  }

  status(code: number) {
    this.statusCode = code;
    return this as unknown as HttpResponse;
  }

  end(body?: string) {
    this.body = body;
    this.ended = true;
    this.finish.forEach((listener) => listener());
    return this;
  }
}

function request(
  url: string,
  headers: HttpRequest['headers'] = {},
  method = 'GET',
  extra: Partial<HttpRequest> = {},
): HttpRequest {
  return { method, url, headers, ...extra };
}

function fakeMetrics() {
  const observed: unknown[][] = [];
  let failing = false;
  const service = {
    observeRequest: (...args: unknown[]) => observed.push(args),
    render: async () => {
      if (failing) throw new Error('boom');
      return 'sentinel_up 1\n';
    },
  } as unknown as MetricsService;
  return { service, observed, fail: () => (failing = true) };
}

async function pass(
  middleware: ReturnType<typeof createMetricsMiddleware>,
  req: HttpRequest,
  res: FakeResponse,
) {
  let nexted = false;
  middleware(req, res as unknown as HttpResponse, () => {
    nexted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return nexted;
}

describe('metrics endpoint', () => {
  const TOKEN = 'a-long-enough-token';

  it('does not exist without a token', async () => {
    const { service } = fakeMetrics();
    const res = new FakeResponse();

    const nexted = await pass(
      createMetricsMiddleware(service, undefined),
      request('/metrics'),
      res,
    );

    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(404);
  });

  it('rejects missing and wrong tokens', async () => {
    const { service } = fakeMetrics();
    const middleware = createMetricsMiddleware(service, TOKEN);

    const none = new FakeResponse();
    await pass(middleware, request('/metrics'), none);
    expect(none.statusCode).toBe(401);
    expect(none.headers['WWW-Authenticate']).toContain('Bearer');
    expect(none.body).toBeUndefined();

    const wrong = new FakeResponse();
    await pass(
      middleware,
      request('/metrics', { authorization: 'Bearer nope' }),
      wrong,
    );
    expect(wrong.statusCode).toBe(401);

    const basic = new FakeResponse();
    await pass(
      middleware,
      request('/metrics', { authorization: `Basic ${TOKEN}` }),
      basic,
    );
    expect(basic.statusCode).toBe(401);

    const query = new FakeResponse();
    await pass(middleware, request(`/metrics?token=${TOKEN}`), query);
    expect(query.statusCode).toBe(401);
  });

  it('serves the exposition text to the right token', async () => {
    const { service } = fakeMetrics();
    const res = new FakeResponse();

    await pass(
      createMetricsMiddleware(service, TOKEN),
      request('/metrics', { authorization: `Bearer ${TOKEN}` }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('sentinel_up 1\n');
    expect(res.headers['Content-Type']).toContain('text/plain');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const { service } = fakeMetrics();
    const middleware = createMetricsMiddleware(service, TOKEN);

    const head = new FakeResponse();
    await pass(
      middleware,
      request('/metrics', { authorization: `Bearer ${TOKEN}` }, 'HEAD'),
      head,
    );
    expect(head.statusCode).toBe(200);
    expect(head.body).toBeUndefined();

    const post = new FakeResponse();
    await pass(
      middleware,
      request('/metrics', { authorization: `Bearer ${TOKEN}` }, 'POST'),
      post,
    );
    expect(post.statusCode).toBe(405);
    expect(post.headers.Allow).toBe('GET, HEAD');
  });

  it('answers 500 without details when rendering fails', async () => {
    const { service, fail } = fakeMetrics();
    fail();
    const res = new FakeResponse();

    await pass(
      createMetricsMiddleware(service, TOKEN),
      request('/metrics', { authorization: `Bearer ${TOKEN}` }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('boom');
  });

  it('leaves other paths alone and records them by route', async () => {
    const { service, observed } = fakeMetrics();
    const middleware = createMetricsMiddleware(service, TOKEN);
    const res = new FakeResponse();
    const req = request('/api/v1/monitors/123?x=1', {}, 'get', {
      route: { path: '/api/v1/monitors/:id' },
    });

    const nexted = await pass(middleware, req, res);
    res.statusCode = 204;
    res.end();

    expect(nexted).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0].slice(0, 3)).toEqual([
      'GET',
      '/api/v1/monitors/:id',
      204,
    ]);
    expect(typeof observed[0][3]).toBe('number');
  });

  it('does not record the metrics requests themselves', async () => {
    const { service, observed } = fakeMetrics();
    const res = new FakeResponse();

    await pass(
      createMetricsMiddleware(service, TOKEN),
      request('/metrics', { authorization: `Bearer ${TOKEN}` }),
      res,
    );

    expect(observed).toHaveLength(0);
  });

  it('keeps route labels bounded', () => {
    expect(routeOf(request('/status/acme/rss.xml'))).toBe('/status/*');
    expect(routeOf(request('/docs-json'))).toBe('/docs*');
    expect(routeOf(request('/anything/at/all/9f8e'))).toBe('unmatched');
    expect(
      routeOf(
        request('/x', {}, 'GET', { baseUrl: '/api', route: { path: '/a' } }),
      ),
    ).toBe('/api/a');
  });

  it('reads bearer tokens strictly', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken(['Bearer abc'])).toBe('abc');
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken('Token abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
