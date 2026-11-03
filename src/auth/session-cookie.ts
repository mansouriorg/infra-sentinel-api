import type { Request, Response } from 'express';
import type { ClientMeta } from './auth.types';

export const SESSION_COOKIE = 'sentinel_session';

export function readSessionToken(
  request: Pick<Request, 'headers'>,
): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice(7).trim() || undefined;
  }
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function readNamedCookie(
  request: Pick<Request, 'headers'>,
  name: string,
): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function setSessionCookie(
  response: Response,
  token: string,
  expiresAt: Date,
  secure: boolean,
): void {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
  });
}

export function clientMeta(
  request: Pick<Request, 'ip' | 'headers'>,
): ClientMeta {
  const agent = request.headers['user-agent'];
  return {
    ip: request.ip ?? 'unknown',
    userAgent: typeof agent === 'string' ? agent.slice(0, 255) : undefined,
  };
}
