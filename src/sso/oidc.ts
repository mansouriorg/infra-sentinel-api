import {
  constants,
  createHash,
  createPublicKey,
  randomBytes,
  verify,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';

export interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  crv?: string;
  [key: string]: unknown;
}

export interface Jwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

interface AlgInfo {
  family: 'RS' | 'PS' | 'ES' | 'EdDSA';
  kty: 'RSA' | 'EC' | 'OKP';
  hash: string | null;
  crv?: string;
}

const ALGS: Record<string, AlgInfo> = {
  RS256: { family: 'RS', kty: 'RSA', hash: 'sha256' },
  RS384: { family: 'RS', kty: 'RSA', hash: 'sha384' },
  RS512: { family: 'RS', kty: 'RSA', hash: 'sha512' },
  PS256: { family: 'PS', kty: 'RSA', hash: 'sha256' },
  PS384: { family: 'PS', kty: 'RSA', hash: 'sha384' },
  PS512: { family: 'PS', kty: 'RSA', hash: 'sha512' },
  ES256: { family: 'ES', kty: 'EC', hash: 'sha256', crv: 'P-256' },
  ES384: { family: 'ES', kty: 'EC', hash: 'sha384', crv: 'P-384' },
  ES512: { family: 'ES', kty: 'EC', hash: 'sha512', crv: 'P-521' },
  EdDSA: { family: 'EdDSA', kty: 'OKP', hash: null, crv: 'Ed25519' },
};

export const SUPPORTED_ALGS = Object.keys(ALGS);
export const MAX_TOKEN_LENGTH = 16_384;
export const CLOCK_SKEW_SEC = 60;

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function generatePkce(): Pkce {
  const verifier = randomUrlToken(32);
  return { verifier, challenge: pkceChallenge(verifier) };
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}

export function authorizationUrl(
  endpoint: string,
  request: AuthorizationRequest,
): string {
  const url = new URL(endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function parseSegment(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Not a token');
  const value: unknown = JSON.parse(
    Buffer.from(segment, 'base64url').toString('utf8'),
  );
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Not a token');
  return value as Record<string, unknown>;
}

export function decodeJwt(token: string): Jwt {
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('Token too long');
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]*$/.test(parts[2]))
    throw new Error('Not a token');
  return {
    header: parseSegment(parts[0]),
    payload: parseSegment(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

export function tokenAlg(jwt: Jwt): string | null {
  const alg = jwt.header.alg;
  return typeof alg === 'string' && Object.hasOwn(ALGS, alg) ? alg : null;
}

export function selectKey(jwt: Jwt, keys: readonly Jwk[]): Jwk | null {
  const alg = tokenAlg(jwt);
  if (!alg) return null;
  const info = ALGS[alg];
  const kid = typeof jwt.header.kid === 'string' ? jwt.header.kid : null;
  const fitting = keys.filter(
    (key) =>
      key.kty === info.kty &&
      (key.use === undefined || key.use === 'sig') &&
      (key.alg === undefined || key.alg === alg) &&
      (info.crv === undefined || key.crv === info.crv),
  );
  if (kid !== null) return fitting.find((key) => key.kid === kid) ?? null;
  return fitting.length === 1 ? fitting[0] : null;
}

export function verifyJwt(jwt: Jwt, key: Jwk): boolean {
  const alg = tokenAlg(jwt);
  if (!alg) return false;
  const info = ALGS[alg];
  try {
    const keyObject: KeyObject = createPublicKey({
      key,
      format: 'jwk',
    } as Parameters<typeof createPublicKey>[0]);
    if (keyObject.type !== 'public') return false;
    if (
      info.kty === 'RSA' &&
      (keyObject.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      return false;
    const data = Buffer.from(jwt.signingInput);
    switch (info.family) {
      case 'RS':
        return verify(info.hash, data, keyObject, jwt.signature);
      case 'PS':
        return verify(
          info.hash,
          data,
          {
            key: keyObject,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
          },
          jwt.signature,
        );
      case 'ES':
        return verify(
          info.hash,
          data,
          { key: keyObject, dsaEncoding: 'ieee-p1363' },
          jwt.signature,
        );
      case 'EdDSA':
        return verify(null, data, keyObject, jwt.signature);
    }
  } catch {
    return false;
  }
}

export interface Identity {
  subject: string;
  email: string;
  emailVerified: boolean | undefined;
  name: string;
}

export interface ExpectedClaims {
  issuer: string;
  clientId: string;
  nonce: string;
}

export type ClaimsResult =
  | { ok: true; identity: Identity }
  | { ok: false; reason: string };

function flag(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

export function readClaims(
  payload: Record<string, unknown>,
  expected: ExpectedClaims,
  nowMs: number = Date.now(),
): ClaimsResult {
  const now = nowMs / 1000;
  if (payload.iss !== expected.issuer) return { ok: false, reason: 'issuer' };

  const audience = payload.aud;
  const audiences =
    typeof audience === 'string'
      ? [audience]
      : Array.isArray(audience)
        ? audience
        : [];
  if (!audiences.includes(expected.clientId))
    return { ok: false, reason: 'audience' };
  if (
    (audiences.length > 1 || payload.azp !== undefined) &&
    payload.azp !== expected.clientId
  ) {
    return { ok: false, reason: 'authorized party' };
  }

  if (
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp) ||
    payload.exp < now - CLOCK_SKEW_SEC
  ) {
    return { ok: false, reason: 'expired' };
  }
  if (
    payload.iat !== undefined &&
    (typeof payload.iat !== 'number' || payload.iat > now + CLOCK_SKEW_SEC)
  ) {
    return { ok: false, reason: 'issued in the future' };
  }
  if (
    payload.nbf !== undefined &&
    (typeof payload.nbf !== 'number' || payload.nbf > now + CLOCK_SKEW_SEC)
  ) {
    return { ok: false, reason: 'not yet valid' };
  }
  if (typeof payload.nonce !== 'string' || payload.nonce !== expected.nonce)
    return { ok: false, reason: 'nonce' };

  const subject = payload.sub;
  if (typeof subject !== 'string' || subject === '' || subject.length > 255)
    return { ok: false, reason: 'subject' };

  const email =
    typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return { ok: false, reason: 'email' };

  const given =
    typeof payload.name === 'string'
      ? payload.name
      : typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : '';
  const name =
    given.replace(/\s+/g, ' ').trim().slice(0, 80) || email.split('@')[0];
  return {
    ok: true,
    identity: {
      subject,
      email,
      emailVerified: flag(payload.email_verified),
      name,
    },
  };
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

export function domainAllowed(
  email: string,
  domains: readonly string[],
): boolean {
  return domains.includes(emailDomain(email));
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
  );
}

export function checkIssuerUrl(raw: string, allowHttp: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter the issuer address, for example https://accounts.example.com';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return 'The issuer must start with https://';
  if (url.protocol === 'http:' && !allowHttp && !isLoopbackHost(url.hostname))
    return 'The issuer must start with https://';
  if (url.username || url.password)
    return 'Remove the user name and password from the address';
  if (url.search || url.hash) return 'Remove the ? and # parts of the address';
  return null;
}

export function endpointAllowed(
  raw: unknown,
  allowHttp: boolean,
): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' && (allowHttp || isLoopbackHost(url.hostname))
    );
  } catch {
    return false;
  }
}

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    'Enter a domain such as example.com',
  );

export const ssoSchema = z.object({
  issuer: z.string().trim().min(8, 'Enter the issuer address').max(500),
  clientId: z.string().trim().min(1, 'Enter the client ID').max(300),
  clientSecret: z.string().min(1).max(2000).optional(),
  allowedDomains: z
    .array(domain)
    .min(1, 'Add at least one email domain')
    .max(20)
    .transform((value) => [...new Set(value)]),
  defaultRole: z.enum(['viewer', 'member', 'admin']).default('member'),
  autoProvision: z.boolean().default(true),
  enabled: z.boolean().default(false),
});

export type SsoInput = z.infer<typeof ssoSchema>;

export const ssoTestSchema = z.object({
  issuer: z.string().trim().min(8).max(500),
});

export const ssoErrors = {
  not_configured: 'Single sign-on is not set up for that organization.',
  invalid_state:
    'The sign-in took too long or was interrupted. Please try again.',
  provider_denied: 'Your identity provider did not allow the sign-in.',
  provider_error:
    'We could not reach your identity provider. Please try again.',
  invalid_token: 'Your identity provider sent a sign-in we could not trust.',
  no_email: 'Your identity provider did not share an email address.',
  email_not_verified:
    'Your identity provider has not verified your email address.',
  domain_not_allowed:
    'Your email address is not allowed to sign in to this organization.',
  account_exists:
    'An account with this email already exists. Ask an administrator to invite you first.',
  no_access: 'You no longer have access to this organization.',
  provisioning_off:
    'New accounts are not created automatically. Ask an administrator to invite you.',
  too_many: 'Too many attempts. Please wait a few minutes.',
} as const;

export type SsoErrorCode = keyof typeof ssoErrors;
