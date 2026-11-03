import type { CheckOutcome, CheckStatus } from '../monitor.types';

export interface RunContext {
  timeoutMs: number;
  blockPrivate: boolean;
}

export function normalizeMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value))
    return null;
  return Math.max(1, Math.round(value));
}

export function outcome(
  status: CheckStatus,
  message: string,
  responseMs: number | null,
  extra: { statusCode?: number | null; sslExpiresAt?: Date | null } = {},
): CheckOutcome {
  return {
    status,
    message,
    responseMs: normalizeMs(responseMs),
    statusCode: extra.statusCode ?? null,
    sslExpiresAt: extra.sslExpiresAt ?? null,
  };
}

export const up = (
  message: string,
  ms: number | null,
  extra?: { statusCode?: number | null; sslExpiresAt?: Date | null },
) => outcome('up', message, ms, extra);

export const down = (
  message: string,
  ms: number | null = null,
  extra?: { statusCode?: number | null; sslExpiresAt?: Date | null },
) => outcome('down', message, ms, extra);

export function applyDegraded(
  result: CheckOutcome,
  degradedMs: number | undefined,
): CheckOutcome {
  if (
    result.status === 'up' &&
    degradedMs !== undefined &&
    result.responseMs !== null &&
    result.responseMs > degradedMs
  ) {
    return {
      ...result,
      status: 'degraded',
      message: `${result.message}, slow (${result.responseMs} ms, limit ${degradedMs} ms)`,
    };
  }
  return result;
}
