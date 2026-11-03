import type { NextFunction, Request, Response } from 'express';
import type { DomainService } from './domain.service';
import { hostOf } from './status.model';

export interface StatusRequest extends Request {
  statusBase?: string;
}

const SLUG_PATH = /^\/status\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])(\/.*)?$/;
const CUSTOM_DOMAIN_PATHS = new Set([
  '/',
  '/rss.xml',
  '/summary.json',
  '/subscribe',
  '/confirm',
  '/unsubscribe',
]);

export function createStatusRouting(
  domains: Pick<DomainService, 'isOwnHost' | 'lookup'>,
  apiPrefix: string,
) {
  return (
    request: StatusRequest,
    response: Response,
    next: NextFunction,
  ): void => {
    const url = request.url || '/';
    const questionMark = url.indexOf('?');
    const path = questionMark === -1 ? url : url.slice(0, questionMark);
    const search = questionMark === -1 ? '' : url.slice(questionMark);

    const match = SLUG_PATH.exec(path);
    if (match) {
      request.statusBase = `/status/${match[1]}`;
      request.url = `/${apiPrefix}/public/status/${match[1]}${match[2] ?? ''}${search}`;
      next();
      return;
    }

    const host = hostOf(request.headers.host);
    if (domains.isOwnHost(host)) {
      next();
      return;
    }
    domains.lookup(host).then(
      (slug) => {
        if (!slug) {
          next();
          return;
        }
        if (path === '/favicon.ico') {
          response.status(204).end();
          return;
        }
        if (!CUSTOM_DOMAIN_PATHS.has(path)) {
          response.status(404).type('text/plain').send('Not found');
          return;
        }
        request.statusBase = '';
        request.url = `/${apiPrefix}/public/status/${slug}${path === '/' ? '' : path}${search}`;
        next();
      },
      () => next(),
    );
  };
}
