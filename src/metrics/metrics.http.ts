import { createHash, timingSafeEqual } from 'node:crypto';
import type { MetricsService } from './metrics.service';

export interface HttpRequest {
  method: string;
  url: string;
  baseUrl?: string;
  route?: { path?: unknown };
  headers: Record<string, string | string[] | undefined>;
}

export interface HttpResponse {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): HttpResponse;
  end(body?: string): unknown;
}

type Next = (error?: unknown) => void;

export const METRICS_PATH = '/metrics';

export function routeOf(request: HttpRequest): string {
  const path = request.route?.path;
  if (typeof path === 'string') return `${request.baseUrl ?? ''}${path}` || '/';
  const url = pathOf(request.url);
  if (url.startsWith('/status/') || url === '/status') return '/status/*';
  if (url.startsWith('/docs')) return '/docs*';
  return 'unmatched';
}

function pathOf(url: string): string {
  const mark = url.indexOf('?');
  return mark === -1 ? url : url.slice(0, mark);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function bearerToken(
  header: string | string[] | undefined,
): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? match[1] : null;
}

function createMetricsHandler(
  metrics: MetricsService,
  token: string | undefined,
) {
  return async (
    request: HttpRequest,
    response: HttpResponse,
  ): Promise<void> => {
    if (!token) {
      response.status(404).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      response.status(405).end();
      return;
    }
    const given = bearerToken(request.headers.authorization);
    if (!given || !timingSafeEqual(digest(given), digest(token))) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      response.status(401).end();
      return;
    }
    try {
      const body = await metrics.render();
      response.setHeader(
        'Content-Type',
        'text/plain; version=0.0.4; charset=utf-8',
      );
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.status(500).end('Metrics are not available right now');
    }
  };
}

export function createMetricsMiddleware(
  metrics: MetricsService,
  token: string | undefined,
) {
  const handle = createMetricsHandler(metrics, token);
  return (request: HttpRequest, response: HttpResponse, next: Next): void => {
    if (pathOf(request.url) === METRICS_PATH) {
      void handle(request, response);
      return;
    }
    const started = process.hrtime.bigint();
    response.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      metrics.observeRequest(
        request.method.toUpperCase(),
        routeOf(request),
        response.statusCode,
        seconds,
      );
    });
    next();
  };
}
