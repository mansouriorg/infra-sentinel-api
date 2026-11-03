const CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface Req {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface Res {
  status(code: number): Res;
  json(body: unknown): unknown;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createCrossSiteGuard(apiPrefix: string) {
  const protectedPrefix = `/${apiPrefix}/auth/`;
  return (
    request: Req,
    response: Res,
    next: (error?: unknown) => void,
  ): void => {
    const path = request.url.split('?')[0];
    if (!CHANGING.has(request.method) || !path.startsWith(protectedPrefix)) {
      next();
      return;
    }
    if (single(request.headers['sec-fetch-site']) === 'cross-site') {
      response
        .status(403)
        .json({
          statusCode: 403,
          message: 'Cross-site requests are not allowed here',
        });
      return;
    }
    const length = Number(single(request.headers['content-length']) ?? 0);
    const hasBody =
      length > 0 || request.headers['transfer-encoding'] !== undefined;
    const type = (single(request.headers['content-type']) ?? '').toLowerCase();
    if (
      hasBody &&
      !/^application\/(json|[a-z0-9.+-]+\+json)\s*(;|$)/.test(type)
    ) {
      response
        .status(415)
        .json({
          statusCode: 415,
          message: 'Send JSON with Content-Type: application/json',
        });
      return;
    }
    next();
  };
}
