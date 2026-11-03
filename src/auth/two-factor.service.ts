import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { hasUsablePassword, verifyPassword } from '../common/crypto';
import { RateLimits } from '../common/rate-limits';
import { SecretBox } from '../common/secret-box';
import { toIso } from '../common/time';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { parseWith } from '../monitors/monitor.schema';
import { canManage } from '../orgs/roles';
import type { Role } from '../orgs/roles';
import type { AuthContext } from './auth.types';
import {
  RECOVERY_CODE_COUNT,
  classifyCode,
  generateRecoveryCodes,
  generateTotpSecret,
  matchTotp,
  normalizeRecoveryCode,
  otpauthUrl,
  type CodeKind,
} from './two-factor';

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
  hasPassword: boolean;
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
}

const ISSUER = 'Infra Sentinel';
const MINUTE = 60_000;

const codeSchema = z.object({
  code: z.string().trim().min(1, 'Enter the code').max(24),
});
const enableSchema = z.object({
  code: z.string().trim().min(1, 'Enter the code').max(24),
  password: z.string().max(200).optional(),
});
const disableSchema = z.object({
  password: z.string().max(200).optional(),
  code: z.string().trim().min(1, 'Enter a code').max(24),
});

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly secrets: SecretBox,
    private readonly limits: RateLimits,
    private readonly mail: MailService,
    private readonly config: AppConfig,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const row = await this.db.row<{ user_id: string }>(
      'SELECT user_id FROM user_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL',
      [userId],
    );
    return row !== null && row !== undefined;
  }

  async status(auth: AuthContext): Promise<TwoFactorStatus> {
    const row = await this.db.row<{ confirmed_at: Date | string | null }>(
      'SELECT confirmed_at FROM user_totp WHERE user_id = $1',
      [auth.user.id],
    );
    const enabled = Boolean(row?.confirmed_at);
    const left = enabled
      ? await this.db.row<{ count: string }>(
          'SELECT count(*) AS count FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
          [auth.user.id],
        )
      : null;
    const user = await this.db.row<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [auth.user.id],
    );
    return {
      enabled,
      enabledAt: enabled && row?.confirmed_at ? toIso(row.confirmed_at) : null,
      recoveryCodesLeft: Number(left?.count ?? 0),
      hasPassword: user ? hasUsablePassword(user.password_hash) : false,
    };
  }

  async setup(auth: AuthContext): Promise<TwoFactorSetup> {
    this.throttle(auth.user.id);
    if (await this.isEnabled(auth.user.id)) {
      throw new ConflictException('Two-factor authentication is already on');
    }
    const secret = generateTotpSecret();
    await this.db.run(
      `INSERT INTO user_totp (user_id, secret_enc) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
          SET secret_enc = EXCLUDED.secret_enc, last_step = 0, created_at = now()
        WHERE user_totp.confirmed_at IS NULL`,
      [auth.user.id, this.secrets.seal(secret)],
    );
    return { secret, otpauthUrl: otpauthUrl(ISSUER, auth.user.email, secret) };
  }

  async enable(
    auth: AuthContext,
    body: unknown,
  ): Promise<{ recoveryCodes: string[] }> {
    const { code, password } = parseWith(enableSchema, body);
    this.throttle(auth.user.id);
    await this.requirePassword(auth.user.id, password);
    const row = await this.db.row<{
      secret_enc: string;
      confirmed_at: Date | string | null;
    }>('SELECT secret_enc, confirmed_at FROM user_totp WHERE user_id = $1', [
      auth.user.id,
    ]);
    if (!row)
      throw new BadRequestException('Start the setup first to get a secret');
    if (row.confirmed_at)
      throw new ConflictException('Two-factor authentication is already on');
    const step = this.matchStored(row.secret_enc, code, 0);
    if (step === null) {
      throw new BadRequestException(
        'That code is not right. Check the clock on your phone and try the newest code.',
      );
    }

    const recoveryCodes = generateRecoveryCodes();
    await this.db.tx(async (tx) => {
      const changed = await tx.run(
        'UPDATE user_totp SET confirmed_at = now(), last_step = $2 WHERE user_id = $1 AND confirmed_at IS NULL',
        [auth.user.id, step],
      );
      if (changed === 0)
        throw new ConflictException('Two-factor authentication is already on');
      await this.storeRecoveryCodes(tx, auth.user.id, recoveryCodes);
      await tx.run('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [
        auth.user.id,
        auth.sessionId,
      ]);
    });
    this.notify(
      auth.user,
      'Two-factor authentication is on',
      'Two-factor authentication was turned on for your Infra Sentinel account. You were signed out on your other devices.',
    );
    return { recoveryCodes };
  }

  async disable(auth: AuthContext, body: unknown): Promise<void> {
    const input = parseWith(disableSchema, body);
    this.throttle(auth.user.id);
    if (!(await this.isEnabled(auth.user.id))) {
      throw new BadRequestException('Two-factor authentication is not on');
    }
    await this.requirePassword(auth.user.id, input.password);
    if (!(await this.verifyCode(auth.user.id, input.code))) {
      throw new BadRequestException('That code is not right');
    }
    await this.clear(auth.user.id);
    this.notify(
      auth.user,
      'Two-factor authentication is off',
      'Two-factor authentication was turned off for your Infra Sentinel account.',
    );
  }

  async regenerateRecoveryCodes(
    auth: AuthContext,
    body: unknown,
  ): Promise<{ recoveryCodes: string[] }> {
    const { code } = parseWith(codeSchema, body);
    this.throttle(auth.user.id);
    if (classifyCode(code) !== 'totp')
      throw new BadRequestException('Enter the 6 digit code from your app');
    if (!(await this.isEnabled(auth.user.id))) {
      throw new BadRequestException('Two-factor authentication is not on');
    }
    if ((await this.verifyCode(auth.user.id, code)) !== 'totp') {
      throw new BadRequestException('That code is not right');
    }
    const recoveryCodes = generateRecoveryCodes();
    await this.db.tx((tx) =>
      this.storeRecoveryCodes(tx, auth.user.id, recoveryCodes),
    );
    this.notify(
      auth.user,
      'New recovery codes',
      'New recovery codes were created for your Infra Sentinel account. The old ones no longer work.',
    );
    return { recoveryCodes };
  }

  async resetMember(actor: AuthContext, targetId: string): Promise<void> {
    if (targetId === actor.user.id) {
      throw new BadRequestException(
        'Turn off your own two-factor authentication in your account settings',
      );
    }
    const member = await this.db.row<{
      role: Role;
      name: string;
      email: string;
    }>(
      `SELECT m.role, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND m.user_id = $2`,
      [actor.orgId, targetId],
    );
    if (!member)
      throw new NotFoundException('That person is not in this organization');
    if (!canManage(actor.role, member.role))
      throw new ForbiddenException('You cannot change that person');
    const others = await this.db.row<{ count: string }>(
      `SELECT count(*) AS count FROM memberships o
        WHERE o.user_id = $1 AND o.org_id <> $2
          AND EXISTS (SELECT 1 FROM memberships x WHERE x.org_id = o.org_id AND x.user_id <> $1)`,
      [targetId, actor.orgId],
    );
    if (Number(others?.count ?? 0) > 0) {
      throw new ForbiddenException(
        'This person also works in other organizations with other people, so only they can change their sign-in security',
      );
    }
    if (!(await this.isEnabled(targetId))) {
      throw new BadRequestException(
        'That person does not use two-factor authentication',
      );
    }
    await this.clear(targetId);
    this.notify(
      { id: targetId, email: member.email, name: member.name },
      'Two-factor authentication was reset',
      `An administrator of your organization (${actor.user.name}) turned off two-factor authentication for your Infra Sentinel account. You can turn it on again in your account settings.`,
    );
  }

  async verifyCode(
    userId: string,
    input: string,
    now: number = Date.now(),
  ): Promise<CodeKind | null> {
    const kind = classifyCode(input);
    if (!kind) return null;
    if (kind === 'totp') {
      const row = await this.db.row<{
        secret_enc: string;
        last_step: string | number;
      }>(
        'SELECT secret_enc, last_step FROM user_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL',
        [userId],
      );
      if (!row) return null;
      const step = this.matchStored(
        row.secret_enc,
        input,
        Number(row.last_step),
        now,
      );
      if (step === null) return null;
      const updated = await this.db.run(
        'UPDATE user_totp SET last_step = $2 WHERE user_id = $1 AND last_step < $2',
        [userId, step],
      );
      return updated === 1 ? 'totp' : null;
    }
    const used = await this.db.run(
      'UPDATE user_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
      [userId, this.hashRecovery(input)],
    );
    return used === 1 ? 'recovery' : null;
  }

  private matchStored(
    sealed: string,
    code: string,
    lastStep: number,
    now: number = Date.now(),
  ): number | null {
    try {
      return matchTotp(this.secrets.open(sealed), code, now, lastStep);
    } catch {
      this.logger.warn(
        'A two-factor secret could not be read. APP_SECRET may have changed.',
      );
      return null;
    }
  }

  private hashRecovery(code: string): string {
    return this.secrets.mac('recovery', normalizeRecoveryCode(code));
  }

  private async storeRecoveryCodes(
    tx: { run(text: string, values?: unknown[]): Promise<number> },
    userId: string,
    codes: string[],
  ): Promise<void> {
    await tx.run('DELETE FROM user_recovery_codes WHERE user_id = $1', [
      userId,
    ]);
    for (const code of codes.slice(0, RECOVERY_CODE_COUNT)) {
      await tx.run(
        'INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)',
        [userId, this.hashRecovery(code)],
      );
    }
  }

  private async clear(userId: string): Promise<void> {
    await this.db.tx(async (tx) => {
      await tx.run('DELETE FROM user_recovery_codes WHERE user_id = $1', [
        userId,
      ]);
      await tx.run('DELETE FROM user_totp WHERE user_id = $1', [userId]);
    });
  }

  private async requirePassword(
    userId: string,
    password: string | undefined,
  ): Promise<void> {
    const user = await this.db.row<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    );
    if (!user) throw new NotFoundException('Account not found');
    if (!hasUsablePassword(user.password_hash)) return;
    if (!password || !(await verifyPassword(password, user.password_hash))) {
      throw new BadRequestException('Your password is incorrect');
    }
  }

  private throttle(userId: string): void {
    const decision = this.limits.hit(`two-factor:${userId}`, 12, 15 * MINUTE);
    if (!decision.allowed) {
      throw new HttpException(
        'Too many attempts. Please wait a few minutes and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  notify(
    user: { id: string; email: string; name: string },
    heading: string,
    detail: string,
  ): void {
    const url = `${this.config.get('WEB_URL').replace(/\/+$/, '')}/settings`;
    this.mail
      .sendSecurityNotice(user.email, user.name, heading, detail, url)
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not send a security notice: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
