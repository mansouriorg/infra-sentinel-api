import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { postRequest } from '../alerting/channels/http-post';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, ClientMeta } from '../auth/auth.types';
import { SessionsService } from '../auth/sessions.service';
import { API_PREFIX } from '../common/api';
import { UNUSABLE_PASSWORD, normalizeEmail } from '../common/crypto';
import { RateLimits } from '../common/rate-limits';
import { SecretBox } from '../common/secret-box';
import { toIso } from '../common/time';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { parseWith } from '../monitors/monitor.schema';
import type { Role } from '../orgs/roles';
import {
  SUPPORTED_ALGS,
  authorizationUrl,
  checkIssuerUrl,
  decodeJwt,
  domainAllowed,
  emailDomain,
  endpointAllowed,
  generatePkce,
  randomUrlToken,
  readClaims,
  selectKey,
  ssoSchema,
  ssoTestSchema,
  verifyJwt,
  type Identity,
  type Jwk,
  type SsoErrorCode,
} from './oidc';

export const SSO_COOKIE = 'sentinel_sso';
export const SSO_COOKIE_PATH = `/${API_PREFIX}/auth/sso`;
export const SSO_COOKIE_MAX_AGE_MS = 10 * 60_000;

export interface SsoView {
  configured: boolean;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  allowedDomains: string[];
  defaultRole: 'viewer' | 'member' | 'admin';
  autoProvision: boolean;
  enabled: boolean;
  redirectUri: string;
  updatedAt: string | null;
}

export interface SsoCheck {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  keys: number;
  algorithms: string[];
}

export interface SsoStart {
  url: string;
  cookie: string;
}

export type SsoFinish =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; code: SsoErrorCode };

interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  authMethod: 'basic' | 'post';
  algorithms: string[];
}

interface ConnectionRow {
  org_id: string;
  issuer: string;
  client_id: string;
  client_secret_enc: string;
  allowed_domains: string[];
  default_role: 'viewer' | 'member' | 'admin';
  auto_provision: boolean;
  enabled: boolean;
  updated_at: Date | string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  email_verified_at: Date | string | null;
}

interface StateClaims extends Record<string, unknown> {
  state: string;
  nonce: string;
  verifier: string;
  org: string;
}

const CACHE_LIMIT = 100;

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

class SsoFailure extends Error {
  constructor(
    readonly code: SsoErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const DISCOVERY_TTL_MS = 10 * 60_000;
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MIN_REFETCH_MS = 60_000;
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 512 * 1024;
const MINUTE = 60_000;

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  private readonly discoveries = new Map<
    string,
    { at: number; value: Discovery }
  >();
  private readonly keySets = new Map<string, { at: number; keys: Jwk[] }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly secrets: SecretBox,
    private readonly limits: RateLimits,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  redirectUri(): string {
    return `${this.config.get('WEB_URL').replace(/\/+$/, '')}/${API_PREFIX}/auth/sso/callback`;
  }

  async view(auth: AuthContext): Promise<SsoView> {
    const row = await this.connection(auth.orgId);
    if (!row) {
      return {
        configured: false,
        issuer: '',
        clientId: '',
        hasSecret: false,
        allowedDomains: [],
        defaultRole: 'member',
        autoProvision: true,
        enabled: false,
        redirectUri: this.redirectUri(),
        updatedAt: null,
      };
    }
    return {
      configured: true,
      issuer: row.issuer,
      clientId: row.client_id,
      hasSecret: row.client_secret_enc !== '',
      allowedDomains: row.allowed_domains,
      defaultRole: row.default_role,
      autoProvision: row.auto_provision,
      enabled: row.enabled,
      redirectUri: this.redirectUri(),
      updatedAt: toIso(row.updated_at),
    };
  }

  async save(auth: AuthContext, body: unknown): Promise<SsoView> {
    const input = parseWith(ssoSchema, body);
    const problem = checkIssuerUrl(
      input.issuer,
      this.config.get('SSO_ALLOW_HTTP'),
    );
    if (problem) throw new BadRequestException(problem);
    const existing = await this.connection(auth.orgId);
    if (!existing && !input.clientSecret)
      throw new BadRequestException('Enter the client secret');

    if (input.enabled) {
      this.discoveries.delete(input.issuer);
      try {
        await this.discover(input.issuer);
      } catch (error) {
        throw new BadRequestException(
          `Single sign-on was not turned on. ${this.explain(error)}`,
        );
      }
    }

    if (existing) {
      const providerChanged =
        existing.issuer !== input.issuer ||
        existing.client_id !== input.clientId;
      const switchedOff = existing.enabled && !input.enabled;
      if (providerChanged || switchedOff)
        await this.revoke(auth.orgId, providerChanged);
      await this.db.run(
        `UPDATE sso_connections
            SET issuer = $2, client_id = $3, client_secret_enc = COALESCE($4, client_secret_enc),
                allowed_domains = $5::text[], default_role = $6, auto_provision = $7, enabled = $8, updated_at = now()
          WHERE org_id = $1`,
        [
          auth.orgId,
          input.issuer,
          input.clientId,
          input.clientSecret ? this.secrets.seal(input.clientSecret) : null,
          input.allowedDomains,
          input.defaultRole,
          input.autoProvision,
          input.enabled,
        ],
      );
    } else {
      await this.db.run(
        `INSERT INTO sso_connections (org_id, issuer, client_id, client_secret_enc, allowed_domains, default_role, auto_provision, enabled)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8)`,
        [
          auth.orgId,
          input.issuer,
          input.clientId,
          this.secrets.seal(input.clientSecret as string),
          input.allowedDomains,
          input.defaultRole,
          input.autoProvision,
          input.enabled,
        ],
      );
    }
    return this.view(auth);
  }

  async remove(auth: AuthContext): Promise<void> {
    const removed = await this.db.tx(async (tx) => {
      const count = await tx.run(
        'DELETE FROM sso_connections WHERE org_id = $1',
        [auth.orgId],
      );
      if (count > 0) {
        await tx.run('DELETE FROM sessions WHERE sso_org_id = $1', [
          auth.orgId,
        ]);
        await tx.run('DELETE FROM sso_identities WHERE org_id = $1', [
          auth.orgId,
        ]);
      }
      return count;
    });
    if (removed === 0)
      throw new NotFoundException('Single sign-on is not set up');
  }

  private async revoke(orgId: string, identities: boolean): Promise<void> {
    await this.db.tx(async (tx) => {
      await tx.run('DELETE FROM sessions WHERE sso_org_id = $1', [orgId]);
      if (identities)
        await tx.run('DELETE FROM sso_identities WHERE org_id = $1', [orgId]);
    });
  }

  async check(auth: AuthContext, body: unknown): Promise<SsoCheck> {
    const { issuer } = parseWith(ssoTestSchema, body);
    this.hit(`sso-check:${auth.user.id}`, 10, MINUTE);
    const problem = checkIssuerUrl(issuer, this.config.get('SSO_ALLOW_HTTP'));
    if (problem) throw new BadRequestException(problem);
    this.discoveries.delete(issuer);
    try {
      const found = await this.discover(issuer);
      const keys = await this.keysFor(found.jwksUri, true);
      if (keys.length === 0)
        throw new SsoFailure(
          'provider_error',
          'The provider published no signing keys.',
        );
      return {
        issuer: found.issuer,
        authorizationEndpoint: found.authorizationEndpoint,
        tokenEndpoint: found.tokenEndpoint,
        jwksUri: found.jwksUri,
        keys: keys.length,
        algorithms: found.algorithms,
      };
    } catch (error) {
      throw new BadRequestException(this.explain(error));
    }
  }

  async lookup(
    email: string,
    ip: string,
  ): Promise<{ organizations: Array<{ slug: string; name: string }> }> {
    this.hit(`sso-lookup:${ip}`, 30, MINUTE);
    const clean = normalizeEmail(email);
    if (clean.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean))
      return { organizations: [] };
    const rows = await this.db.rows<{ slug: string; name: string }>(
      `SELECT o.slug, o.name FROM sso_connections c JOIN organizations o ON o.id = c.org_id
        WHERE c.enabled AND $1 = ANY(c.allowed_domains) ORDER BY o.name LIMIT 5`,
      [emailDomain(clean)],
    );
    return { organizations: rows };
  }

  async begin(
    slug: string,
    ip: string,
  ): Promise<SsoStart | { code: SsoErrorCode }> {
    if (!this.limits.hit(`sso-start:${ip}`, 30, MINUTE).allowed)
      return { code: 'too_many' };
    const row = await this.db.row<ConnectionRow & { slug: string }>(
      `SELECT c.*, o.slug FROM sso_connections c JOIN organizations o ON o.id = c.org_id
        WHERE o.slug = $1 AND c.enabled`,
      [slug.slice(0, 100)],
    );
    if (!row) return { code: 'not_configured' };
    let found: Discovery;
    try {
      found = await this.discover(row.issuer);
    } catch (error) {
      this.logger.warn(
        `Single sign-on discovery failed for ${row.issuer}: ${this.explain(error)}`,
      );
      return { code: 'provider_error' };
    }
    const pkce = generatePkce();
    const state = randomUrlToken(24);
    const nonce = randomUrlToken(24);
    const cookie = this.secrets.sign(
      'sso',
      { state, nonce, verifier: pkce.verifier, org: row.org_id },
      SSO_COOKIE_MAX_AGE_MS,
    );
    const url = authorizationUrl(found.authorizationEndpoint, {
      clientId: row.client_id,
      redirectUri: this.redirectUri(),
      state,
      nonce,
      challenge: pkce.challenge,
    });
    return { url, cookie };
  }

  async finish(
    query: { code?: string; state?: string; error?: string },
    cookie: string | undefined,
    meta: ClientMeta,
  ): Promise<SsoFinish> {
    if (!this.limits.hit(`sso-callback:${meta.ip}`, 30, MINUTE).allowed)
      return { ok: false, code: 'too_many' };
    const claims = this.secrets.verify<StateClaims>('sso', cookie);
    if (
      !claims ||
      typeof claims.state !== 'string' ||
      query.state !== claims.state
    )
      return { ok: false, code: 'invalid_state' };
    if (query.error) return { ok: false, code: 'provider_denied' };
    if (!query.code || query.code.length > 4096)
      return { ok: false, code: 'provider_error' };

    const row = await this.connection(claims.org);
    if (!row || !row.enabled) return { ok: false, code: 'not_configured' };

    try {
      const found = await this.discover(row.issuer);
      const idToken = await this.exchange(
        found,
        row,
        query.code,
        claims.verifier,
      );
      const identity = await this.verifyIdToken(
        found,
        row,
        idToken,
        claims.nonce,
      );
      if (!domainAllowed(identity.email, row.allowed_domains))
        throw new SsoFailure('domain_not_allowed', 'domain');
      const user = await this.resolve(row, identity, meta);
      const session = await this.sessions.create(
        user.id,
        row.org_id,
        meta,
        row.org_id,
      );
      void this.audit.record({
        orgId: row.org_id,
        actorType: 'user',
        actorId: user.id,
        actorLabel: user.email,
        action: 'auth.login',
        targetType: 'users',
        targetId: user.id,
        summary: user.name,
        metadata: { method: 'sso' },
        ip: meta.ip || null,
        userAgent: meta.userAgent ?? null,
      });
      return { ok: true, token: session.token, expiresAt: session.expiresAt };
    } catch (error) {
      if (error instanceof SsoFailure) {
        if (
          error.code !== 'domain_not_allowed' &&
          error.code !== 'account_exists'
        ) {
          this.logger.warn(
            `Single sign-on failed (${error.code}): ${error.message}`,
          );
        }
        return { ok: false, code: error.code };
      }
      this.logger.error(
        `Single sign-on failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, code: 'provider_error' };
    }
  }

  private async resolve(
    row: ConnectionRow,
    identity: Identity,
    meta: ClientMeta,
  ): Promise<UserRow> {
    const email = normalizeEmail(identity.email);
    return this.db.tx(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `sso:${row.org_id}:${identity.subject}:${email}`,
      ]);

      const linked = await tx.row<UserRow & { role: Role | null }>(
        `SELECT u.id, u.email, u.name, u.email_verified_at, m.role
           FROM sso_identities i
           JOIN users u ON u.id = i.user_id
           LEFT JOIN memberships m ON m.org_id = i.org_id AND m.user_id = u.id
          WHERE i.org_id = $1 AND i.issuer = $2 AND i.subject = $3`,
        [row.org_id, row.issuer, identity.subject],
      );
      if (linked) {
        if (!linked.role)
          throw new SsoFailure('no_access', 'membership removed');
        return linked;
      }

      const local = await tx.row<UserRow & { role: Role | null }>(
        `SELECT u.id, u.email, u.name, u.email_verified_at, m.role
           FROM users u
           LEFT JOIN memberships m ON m.org_id = $2 AND m.user_id = u.id
          WHERE u.email = $1`,
        [email, row.org_id],
      );

      if (local) {
        if (!local.role) throw new SsoFailure('account_exists', 'not a member');
        if (identity.emailVerified !== true)
          throw new SsoFailure(
            'email_not_verified',
            'email_verified is not true',
          );
        await tx.run(
          'INSERT INTO sso_identities (org_id, issuer, subject, user_id) VALUES ($1, $2, $3, $4)',
          [row.org_id, row.issuer, identity.subject, local.id],
        );
        if (!local.email_verified_at) {
          await tx.run(
            `UPDATE users SET password_hash = $2, email_verified_at = now(), updated_at = now() WHERE id = $1`,
            [local.id, UNUSABLE_PASSWORD],
          );
          await tx.run('DELETE FROM sessions WHERE user_id = $1', [local.id]);
          await tx.run(
            `DELETE FROM user_tokens WHERE user_id = $1 AND used_at IS NULL`,
            [local.id],
          );
        }
        this.note(row.org_id, local, 'auth.sso_link', meta);
        return local;
      }

      if (!row.auto_provision)
        throw new SsoFailure('provisioning_off', 'auto provisioning is off');
      if (identity.emailVerified === false)
        throw new SsoFailure('email_not_verified', 'email_verified is false');
      const created = await tx.row<UserRow>(
        `INSERT INTO users (email, name, password_hash, email_verified_at)
         VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END)
         RETURNING id, email, name, email_verified_at`,
        [
          email,
          identity.name,
          UNUSABLE_PASSWORD,
          identity.emailVerified === true,
        ],
      );
      if (!created) throw new Error('The account was not created');
      await tx.run(
        'INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)',
        [row.org_id, created.id, row.default_role],
      );
      await tx.run(
        'INSERT INTO sso_identities (org_id, issuer, subject, user_id) VALUES ($1, $2, $3, $4)',
        [row.org_id, row.issuer, identity.subject, created.id],
      );
      this.note(row.org_id, created, 'auth.sso_provision', meta, {
        role: row.default_role,
      });
      return created;
    });
  }

  private note(
    orgId: string,
    user: UserRow,
    action: string,
    meta: ClientMeta,
    metadata: Record<string, unknown> = {},
  ): void {
    void this.audit.record({
      orgId,
      actorType: 'user',
      actorId: user.id,
      actorLabel: user.email,
      action,
      targetType: 'users',
      targetId: user.id,
      summary: user.name,
      metadata,
      ip: meta.ip || null,
      userAgent: meta.userAgent ?? null,
    });
  }

  private async exchange(
    found: Discovery,
    row: ConnectionRow,
    code: string,
    verifier: string,
  ): Promise<string> {
    let secret: string;
    try {
      secret = this.secrets.open(row.client_secret_enc);
    } catch {
      throw new SsoFailure(
        'provider_error',
        'The client secret could not be read. Enter it again in the settings.',
      );
    }
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: verifier,
      client_id: row.client_id,
    });
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (found.authMethod === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(row.client_id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    } else {
      form.set('client_secret', secret);
    }
    let response;
    try {
      response = await postRequest(found.tokenEndpoint, {
        method: 'POST',
        headers,
        body: form.toString(),
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        blockPrivate: this.config.get('BLOCK_PRIVATE_TARGETS'),
      });
    } catch (error) {
      throw new SsoFailure(
        'provider_error',
        error instanceof Error ? error.message : 'token request failed',
      );
    }
    if (response.status !== 200)
      throw new SsoFailure(
        'provider_error',
        `The token endpoint answered with HTTP ${response.status}`,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new SsoFailure(
        'provider_error',
        'The token endpoint did not answer with JSON',
      );
    }
    const idToken =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { id_token?: unknown }).id_token
        : undefined;
    if (typeof idToken !== 'string')
      throw new SsoFailure(
        'invalid_token',
        'The token endpoint sent no id_token',
      );
    return idToken;
  }

  private async verifyIdToken(
    found: Discovery,
    row: ConnectionRow,
    token: string,
    nonce: string,
  ): Promise<Identity> {
    let jwt;
    try {
      jwt = decodeJwt(token);
    } catch {
      throw new SsoFailure('invalid_token', 'The id_token could not be read');
    }
    let key = selectKey(jwt, await this.keysFor(found.jwksUri, false));
    if (!key && typeof jwt.header.kid === 'string')
      key = selectKey(jwt, await this.keysFor(found.jwksUri, true));
    if (!key || !verifyJwt(jwt, key))
      throw new SsoFailure(
        'invalid_token',
        'The id_token signature is not valid',
      );
    const claims = readClaims(jwt.payload, {
      issuer: row.issuer,
      clientId: row.client_id,
      nonce,
    });
    if (!claims.ok)
      throw new SsoFailure(
        claims.reason === 'email' ? 'no_email' : 'invalid_token',
        `The id_token ${claims.reason} is not valid`,
      );
    return claims.identity;
  }

  private async discover(issuer: string): Promise<Discovery> {
    const cached = this.discoveries.get(issuer);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS)
      return cached.value;
    const allowHttp = this.config.get('SSO_ALLOW_HTTP');
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const doc = (await this.getJson(url)) as Record<string, unknown>;
    if (doc.issuer !== issuer) {
      throw new SsoFailure(
        'provider_error',
        `The provider says its issuer is "${String(doc.issuer)}". Use exactly that address.`,
      );
    }
    const {
      authorization_endpoint: authorization,
      token_endpoint: token,
      jwks_uri: jwks,
    } = doc;
    if (
      !endpointAllowed(authorization, allowHttp) ||
      !endpointAllowed(token, allowHttp) ||
      !endpointAllowed(jwks, allowHttp)
    ) {
      throw new SsoFailure(
        'provider_error',
        'The provider did not give valid https addresses for sign-in, tokens and keys.',
      );
    }
    const advertised = Array.isArray(doc.id_token_signing_alg_values_supported)
      ? (doc.id_token_signing_alg_values_supported as unknown[]).filter(
          (alg): alg is string => typeof alg === 'string',
        )
      : null;
    const algorithms = advertised
      ? advertised.filter((alg) => SUPPORTED_ALGS.includes(alg))
      : ['RS256'];
    if (algorithms.length === 0)
      throw new SsoFailure(
        'provider_error',
        'The provider only signs tokens with algorithms we do not accept.',
      );
    if (
      Array.isArray(doc.code_challenge_methods_supported) &&
      !doc.code_challenge_methods_supported.includes('S256')
    ) {
      throw new SsoFailure(
        'provider_error',
        'The provider does not support PKCE (S256).',
      );
    }
    const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
      ? (doc.token_endpoint_auth_methods_supported as unknown[])
      : null;
    let authMethod: 'basic' | 'post' = 'basic';
    if (methods && !methods.includes('client_secret_basic')) {
      if (!methods.includes('client_secret_post')) {
        throw new SsoFailure(
          'provider_error',
          'The provider needs a client login method we do not support.',
        );
      }
      authMethod = 'post';
    }
    const value: Discovery = {
      issuer,
      authorizationEndpoint: authorization,
      tokenEndpoint: token,
      jwksUri: jwks,
      authMethod,
      algorithms,
    };
    remember(this.discoveries, issuer, { at: Date.now(), value });
    return value;
  }

  private async keysFor(uri: string, refresh: boolean): Promise<Jwk[]> {
    const cached = this.keySets.get(uri);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && (refresh ? age < JWKS_MIN_REFETCH_MS : age < JWKS_TTL_MS))
      return cached.keys;
    const doc = (await this.getJson(uri)) as { keys?: unknown };
    const keys = Array.isArray(doc.keys)
      ? doc.keys.filter(
          (key): key is Jwk =>
            typeof key === 'object' && key !== null && !Array.isArray(key),
        )
      : [];
    remember(this.keySets, uri, { at: Date.now(), keys });
    return keys;
  }

  private async getJson(url: string): Promise<unknown> {
    if (!endpointAllowed(url, this.config.get('SSO_ALLOW_HTTP'))) {
      throw new SsoFailure(
        'provider_error',
        'Addresses must start with https://',
      );
    }
    let response;
    try {
      response = await postRequest(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        blockPrivate: this.config.get('BLOCK_PRIVATE_TARGETS'),
      });
    } catch (error) {
      throw new SsoFailure(
        'provider_error',
        error instanceof Error ? error.message : 'request failed',
      );
    }
    if (response.status !== 200)
      throw new SsoFailure(
        'provider_error',
        `${url} answered with HTTP ${response.status}`,
      );
    try {
      return JSON.parse(response.body);
    } catch {
      throw new SsoFailure('provider_error', `${url} did not answer with JSON`);
    }
  }

  private async connection(orgId: string): Promise<ConnectionRow | null> {
    return (
      (await this.db.row<ConnectionRow>(
        'SELECT * FROM sso_connections WHERE org_id = $1',
        [orgId],
      )) ?? null
    );
  }

  private explain(error: unknown): string {
    return error instanceof SsoFailure || error instanceof Error
      ? error.message
      : String(error);
  }

  private hit(key: string, limit: number, windowMs: number): void {
    if (!this.limits.hit(key, limit, windowMs).allowed) {
      throw new HttpException(
        'Too many attempts. Please wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
