import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  decoyHash,
  hasUsablePassword,
  hashPassword,
  normalizeEmail,
  randomToken,
  sha256,
  verifyPassword,
} from '../common/crypto';
import { RateLimiter } from '../common/rate-limiter';
import { SecretBox } from '../common/secret-box';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import {
  createOrganization,
  listOrganizations,
  type OrgSummary,
} from '../orgs/orgs.queries';
import { isLocale, type Locale } from '../preferences/preferences.types';
import type { AuthContext, AuthUser, ClientMeta } from './auth.types';
import { SessionsService } from './sessions.service';
import { SIGNUPS_CLOSED_MESSAGE, signupAllowed } from './signups';
import { TwoFactorService } from './two-factor.service';

export interface MeResponse {
  user: AuthUser;
  organization: OrgSummary;
  organizations: OrgSummary[];
  preferences: { locale: Locale | null };
}

export interface SessionResult {
  token: string;
  expiresAt: Date;
  me: MeResponse;
}

export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challenge: string;
}

export type LoginResult = SessionResult | TwoFactorChallenge;

export function isChallenge(result: LoginResult): result is TwoFactorChallenge {
  return 'twoFactorRequired' in result;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  email_verified_at: Date | null;
}

type TokenKind = 'verify_email' | 'reset_password';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LOGIN_PER_IP = 300;
const LOGIN_FAILURES_PER_ACCOUNT = 100;
const RESET_PER_IP = 20;

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private readonly limiter = new RateLimiter();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly sessions: SessionsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly twoFactor: TwoFactorService,
    private readonly secrets: SecretBox,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.cleanup(), HOUR);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async register(
    input: {
      name: string;
      email: string;
      password: string;
      organizationName?: string;
    },
    meta: ClientMeta,
  ): Promise<SessionResult> {
    this.throttle(`register:${meta.ip}`, 20, HOUR);
    const email = normalizeEmail(input.email);
    await this.assertSignupsOpen(email);
    const name = input.name.trim();
    const passwordHash = await hashPassword(input.password);

    const created = await this.db.tx(async (tx) => {
      const user = await tx.row<{ id: string }>(
        `INSERT INTO users (email, name, password_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [email, name, passwordHash],
      );
      if (!user)
        throw new ConflictException(
          'An account with this email already exists',
        );
      const orgName = input.organizationName?.trim() || `${name}'s workspace`;
      const org = await createOrganization(tx, user.id, orgName);
      return { userId: user.id, org };
    });

    const session = await this.sessions.create(
      created.userId,
      created.org.id,
      meta,
    );
    this.background(this.sendVerification(created.userId, email, name));
    this.note(
      created.org.id,
      { id: created.userId, email, name },
      'auth.register',
      meta,
    );

    return {
      ...session,
      me: {
        user: { id: created.userId, email, name, emailVerified: false },
        organization: created.org,
        organizations: [created.org],
        preferences: { locale: null },
      },
    };
  }

  async login(
    input: { email: string; password: string },
    meta: ClientMeta,
  ): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const key = `login:${meta.ip}:${email}`;
    const account = `login-account:${email}`;
    this.throttle(`login-ip:${meta.ip}`, LOGIN_PER_IP, 15 * MINUTE);
    this.throttle(key, 10, 15 * MINUTE);
    if (this.limiter.blocked(account, LOGIN_FAILURES_PER_ACCOUNT, HOUR)) {
      throw new HttpException(
        'Too many attempts. Please wait a few minutes and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.db.row<UserRow>(
      `SELECT id, email, name, password_hash, email_verified_at FROM users WHERE email = $1`,
      [email],
    );
    const stored =
      user && hasUsablePassword(user.password_hash)
        ? user.password_hash
        : await decoyHash();
    const valid = await verifyPassword(input.password, stored);
    if (!user || !valid) {
      this.limiter.record(account, HOUR);
      if (user) this.noteFailure(user, 'auth.login_failed', meta);
      throw new UnauthorizedException('Invalid email or password');
    }
    this.limiter.reset(key);
    this.limiter.reset(account);

    if (await this.twoFactor.isEnabled(user.id)) {
      return {
        twoFactorRequired: true,
        challenge: this.secrets.sign('login-2fa', { uid: user.id }, 5 * MINUTE),
      };
    }
    return this.begin(user, meta, 'password');
  }

  async loginTwoFactor(
    input: { challenge: string; code: string },
    meta: ClientMeta,
  ): Promise<SessionResult> {
    const claim = this.secrets.verify<{ uid: string }>(
      'login-2fa',
      input.challenge,
    );
    if (!claim || typeof claim.uid !== 'string') {
      throw new UnauthorizedException(
        'This sign-in has expired. Enter your password again.',
      );
    }
    this.throttle(`2fa:${claim.uid}`, 8, 15 * MINUTE);
    this.throttle(`2fa-ip:${meta.ip}`, 40, 15 * MINUTE);

    const user = await this.db.row<UserRow>(
      'SELECT id, email, name, password_hash, email_verified_at FROM users WHERE id = $1',
      [claim.uid],
    );
    if (!user)
      throw new UnauthorizedException(
        'This sign-in has expired. Enter your password again.',
      );

    const kind = await this.twoFactor.verifyCode(user.id, input.code);
    if (!kind) {
      this.noteFailure(user, 'auth.two_factor_failed', meta);
      throw new UnauthorizedException(
        'That code is not right. Try the newest code from your app, or use a recovery code.',
      );
    }
    this.limiter.reset(`2fa:${claim.uid}`);
    if (kind === 'recovery') {
      this.twoFactor.notify(
        user,
        'A recovery code was used',
        'A recovery code was used to sign in to your Infra Sentinel account. Each code works once.',
      );
    }
    return this.begin(
      user,
      meta,
      kind === 'recovery' ? 'recovery_code' : 'password_and_code',
    );
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.sessions.revokeByToken(token);
  }

  me(auth: AuthContext): Promise<MeResponse> {
    return this.describe(auth.user, auth.orgId, auth.ssoOrgId);
  }

  async updateProfile(auth: AuthContext, name: string): Promise<MeResponse> {
    const trimmed = name.trim();
    await this.db.run(
      'UPDATE users SET name = $1, updated_at = now() WHERE id = $2',
      [trimmed, auth.user.id],
    );
    return this.describe(
      { ...auth.user, name: trimmed },
      auth.orgId,
      auth.ssoOrgId,
    );
  }

  async changePassword(
    auth: AuthContext,
    current: string,
    next: string,
  ): Promise<void> {
    this.throttle(`password:${auth.user.id}`, 10, 15 * MINUTE);
    const user = await this.db.row<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [auth.user.id],
    );
    if (user && !hasUsablePassword(user.password_hash)) {
      throw new BadRequestException(
        'This account has no password. Use "Forgot password" on the sign-in page to create one.',
      );
    }
    if (!user || !(await verifyPassword(current, user.password_hash))) {
      throw new BadRequestException('Your current password is incorrect');
    }
    const hash = await hashPassword(next);
    await this.db.run(
      'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [hash, auth.user.id],
    );
    await this.sessions.revokeOthers(auth.user.id, auth.sessionId);
  }

  async forgotPassword(emailInput: string, meta: ClientMeta): Promise<void> {
    this.throttle(`forgot:${meta.ip}`, 10, 15 * MINUTE);
    const email = normalizeEmail(emailInput);
    const user = await this.db.row<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE email = $1',
      [email],
    );
    if (!user) return;
    const token = await this.issueToken(user.id, 'reset_password', HOUR);
    const url = `${this.webUrl()}/reset-password?token=${token}`;
    this.background(this.mail.sendPasswordReset(email, user.name, url));
  }

  async resetPassword(
    token: string,
    password: string,
    meta?: ClientMeta,
  ): Promise<void> {
    this.throttle(`reset:${meta?.ip ?? 'unknown'}`, RESET_PER_IP, 15 * MINUTE);
    const live = await this.db.row<{ ok: number }>(
      `SELECT 1 AS ok FROM user_tokens
        WHERE token_hash = $1 AND kind = 'reset_password' AND used_at IS NULL AND expires_at > now()`,
      [sha256(token)],
    );
    if (!live)
      throw new BadRequestException(
        'This reset link is invalid or has expired',
      );
    const hash = await hashPassword(password);
    const userId = await this.db.tx(async (tx) => {
      const row = await tx.row<{ user_id: string }>(
        `UPDATE user_tokens SET used_at = now()
          WHERE token_hash = $1 AND kind = 'reset_password'
            AND used_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [sha256(token)],
      );
      if (!row) return null;
      await tx.run(
        `UPDATE users
            SET password_hash = $1,
                email_verified_at = COALESCE(email_verified_at, now()),
                updated_at = now()
          WHERE id = $2`,
        [hash, row.user_id],
      );
      await tx.run('DELETE FROM sessions WHERE user_id = $1', [row.user_id]);
      return row.user_id;
    });
    if (!userId)
      throw new BadRequestException(
        'This reset link is invalid or has expired',
      );
    const user = await this.db.row<{ id: string; email: string; name: string }>(
      'SELECT id, email, name FROM users WHERE id = $1',
      [userId],
    );
    if (user) this.noteAll(user, 'auth.password_reset', meta ?? { ip: '' });
  }

  async verifyEmail(token: string): Promise<void> {
    const done = await this.db.tx(async (tx) => {
      const row = await tx.row<{ user_id: string }>(
        `UPDATE user_tokens SET used_at = now()
          WHERE token_hash = $1 AND kind = 'verify_email'
            AND used_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [sha256(token)],
      );
      if (!row) return false;
      await tx.run(
        `UPDATE users
            SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
          WHERE id = $1`,
        [row.user_id],
      );
      return true;
    });
    if (!done)
      throw new BadRequestException(
        'This confirmation link is invalid or has expired',
      );
  }

  async resendVerification(auth: AuthContext): Promise<void> {
    if (auth.user.emailVerified) return;
    this.throttle(`resend:${auth.user.id}`, 3, HOUR);
    this.background(
      this.sendVerification(auth.user.id, auth.user.email, auth.user.name),
    );
  }

  private async describe(
    user: AuthUser,
    orgId: string | undefined,
    ssoOrgId?: string | null,
  ): Promise<MeResponse> {
    const all = await listOrganizations(this.db, user.id);
    const organizations = ssoOrgId
      ? all.filter((org) => org.id === ssoOrgId)
      : all;
    const organization =
      organizations.find((org) => org.id === orgId) ?? organizations[0];
    if (!organization)
      throw new UnauthorizedException('No organization found for this account');
    const preferences = await this.db.row<{ locale: string | null }>(
      'SELECT locale FROM user_preferences WHERE user_id = $1',
      [user.id],
    );
    return {
      user,
      organization,
      organizations,
      preferences: {
        locale: isLocale(preferences?.locale) ? preferences.locale : null,
      },
    };
  }

  private async begin(
    user: Pick<UserRow, 'id' | 'email' | 'name' | 'email_verified_at'>,
    meta: ClientMeta,
    method: string,
  ): Promise<SessionResult> {
    const organizations = await listOrganizations(this.db, user.id);
    const session = await this.sessions.create(
      user.id,
      organizations[0]?.id ?? null,
      meta,
    );
    const me = await this.describe(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.email_verified_at !== null,
      },
      organizations[0]?.id,
    );
    this.note(organizations[0]?.id ?? null, user, 'auth.login', meta, {
      method,
    });
    return { ...session, me };
  }

  private note(
    orgId: string | null,
    user: { id: string; email: string; name: string },
    action: string,
    meta: ClientMeta,
    metadata: Record<string, unknown> = {},
  ): void {
    if (!orgId) return;
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

  private noteAll(
    user: { id: string; email: string; name: string },
    action: string,
    meta: ClientMeta,
    metadata: Record<string, unknown> = {},
  ): void {
    void this.audit.recordForUser(user.id, {
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

  private noteFailure(
    user: { id: string; email: string; name: string },
    action: string,
    meta: ClientMeta,
  ): void {
    if (this.limiter.attempt(`audit:${action}:${user.id}`, 1, 10 * MINUTE))
      this.noteAll(user, action, meta);
  }

  private async sendVerification(
    userId: string,
    email: string,
    name: string,
  ): Promise<void> {
    const token = await this.issueToken(userId, 'verify_email', 24 * HOUR);
    await this.mail.sendVerification(
      email,
      name,
      `${this.webUrl()}/verify-email?token=${token}`,
    );
  }

  private async issueToken(
    userId: string,
    kind: TokenKind,
    ttlMs: number,
  ): Promise<string> {
    const token = randomToken();
    await this.db.tx(async (tx) => {
      await tx.run(
        'DELETE FROM user_tokens WHERE user_id = $1 AND kind = $2 AND used_at IS NULL',
        [userId, kind],
      );
      await tx.run(
        `INSERT INTO user_tokens (user_id, kind, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [userId, kind, sha256(token), new Date(Date.now() + ttlMs)],
      );
    });
    return token;
  }

  private async assertSignupsOpen(email: string): Promise<void> {
    const mode = this.config.get('SIGNUPS');
    if (mode === 'open') return;
    const state = await this.db.row<{ first: boolean; invited: boolean }>(
      `SELECT NOT EXISTS (SELECT 1 FROM users) AS first,
              EXISTS (SELECT 1 FROM invitations
                       WHERE email = $1 AND accepted_at IS NULL AND expires_at > now()) AS invited`,
      [email],
    );
    if (!signupAllowed(mode, state?.first ?? false, state?.invited ?? false)) {
      throw new ForbiddenException(SIGNUPS_CLOSED_MESSAGE);
    }
  }

  private throttle(key: string, limit: number, windowMs: number): void {
    if (!this.limiter.attempt(key, limit, windowMs)) {
      throw new HttpException(
        'Too many attempts. Please wait a few minutes and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private background(task: Promise<unknown>): void {
    task.catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Background task failed: ${reason}`);
    });
  }

  private webUrl(): string {
    return this.config.get('WEB_URL').replace(/\/+$/, '');
  }

  private async cleanup(): Promise<void> {
    try {
      await this.sessions.purgeExpired();
      await this.db.run(
        `DELETE FROM user_tokens
          WHERE expires_at < now() - interval '7 days' OR used_at < now() - interval '7 days'`,
      );
      await this.db.run(
        `DELETE FROM invitations WHERE expires_at < now() - interval '30 days'`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Cleanup failed: ${reason}`);
    }
  }
}
