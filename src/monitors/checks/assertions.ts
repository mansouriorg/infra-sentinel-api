export function parseStatusExpectation(
  expression: string,
): (status: number) => boolean {
  const ranges = expression
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [from, to] = part.split('-').map((value) => Number(value));
      return [from, Number.isFinite(to) ? to : from] as const;
    });
  return (status) =>
    ranges.some(([from, to]) => status >= from && status <= to);
}

export function readJsonPath(value: unknown, path: string): unknown {
  const tokens = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((token) => token.trim())
    .filter(Boolean);
  let current: unknown = value;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export interface CertificateFacts {
  validTo: Date | null;
  authorized: boolean;
  authorizationError: string | null;
}

export interface CertificateVerdict {
  status: 'up' | 'degraded' | 'down';
  message: string;
  daysLeft: number | null;
}

export function evaluateCertificate(
  facts: CertificateFacts,
  options: { warnDays: number; allowUntrusted: boolean },
  now: Date = new Date(),
): CertificateVerdict {
  if (!facts.validTo || Number.isNaN(facts.validTo.getTime())) {
    return {
      status: 'down',
      message: 'The server did not present a certificate',
      daysLeft: null,
    };
  }
  const daysLeft = Math.floor(
    (facts.validTo.getTime() - now.getTime()) / 86_400_000,
  );
  if (facts.validTo.getTime() <= now.getTime()) {
    const ago = Math.max(1, Math.abs(daysLeft));
    return {
      status: 'down',
      message: `Certificate expired ${ago} day${ago === 1 ? '' : 's'} ago`,
      daysLeft,
    };
  }
  if (!facts.authorized && !options.allowUntrusted) {
    return {
      status: 'down',
      message: `Certificate is not trusted: ${facts.authorizationError ?? 'unknown reason'}`,
      daysLeft,
    };
  }
  if (daysLeft <= options.warnDays) {
    return {
      status: 'degraded',
      message: `Certificate expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      daysLeft,
    };
  }
  return {
    status: 'up',
    message: `Certificate valid for ${daysLeft} more days`,
    daysLeft,
  };
}

export function describeNetworkError(
  error: unknown,
  timeoutMs: number,
): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'ECONNREFUSED':
      return 'Connection refused';
    case 'ECONNRESET':
      return 'Connection reset by the server';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Host name could not be resolved';
    case 'EHOSTUNREACH':
      return 'Host unreachable';
    case 'ENETUNREACH':
      return 'Network unreachable';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return `Timed out after ${timeoutMs} ms`;
    case 'CERT_HAS_EXPIRED':
      return 'TLS error: the certificate has expired';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'TLS error: self-signed certificate';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return 'TLS error: the certificate chain is not trusted';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'TLS error: the certificate does not match the host name';
    case 'EBLOCKED':
      return message;
  }
  if (/timed? ?out/i.test(message)) return `Timed out after ${timeoutMs} ms`;
  return message.length > 200 ? `${message.slice(0, 200)}...` : message;
}
