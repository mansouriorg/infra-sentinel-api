import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { RateLimiter } from '../common/rate-limiter';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { testMessage } from './alert.message';
import { toChannelView } from './alert.format';
import { assertOwned, inUse, notFound } from './alert.helpers';
import {
  channelCreateSchema,
  channelTestSchema,
  channelUpdateSchema,
  parseChannelConfig,
  parseWith,
  restoreChannelConfig,
} from './alert.schema';
import type { ChannelRow, ChannelType, ChannelView } from './alert.types';
import { deliver } from './channels/adapters';

export const MAX_CHANNELS_PER_ORG = 50;

@Injectable()
export class ChannelsService {
  private readonly limiter = new RateLimiter();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly mail: MailService,
  ) {}

  async list(auth: AuthContext): Promise<ChannelView[]> {
    const rows = await this.db.rows<ChannelRow>(
      'SELECT * FROM notification_channels WHERE org_id = $1 ORDER BY created_at, name',
      [auth.orgId],
    );
    return rows.map(toChannelView);
  }

  async create(auth: AuthContext, body: unknown): Promise<ChannelView> {
    const input = parseWith(channelCreateSchema, body);
    const config = parseChannelConfig(input.type, input.config);
    const count = await this.db.row<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification_channels WHERE org_id = $1',
      [auth.orgId],
    );
    if ((count?.n ?? 0) >= MAX_CHANNELS_PER_ORG) {
      throw new BadRequestException(
        `A workspace can have up to ${MAX_CHANNELS_PER_ORG} channels`,
      );
    }
    const row = await this.db.row<ChannelRow>(
      `INSERT INTO notification_channels (org_id, name, type, config, enabled, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::uuid) RETURNING *`,
      [
        auth.orgId,
        input.name,
        input.type,
        JSON.stringify(config),
        input.enabled,
        auth.user.id,
      ],
    );
    if (!row) throw new Error('Channel was not created');
    return toChannelView(row);
  }

  async update(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<ChannelView> {
    const patch = parseWith(channelUpdateSchema, body);
    const row = await this.require(auth.orgId, id);
    const config = patch.config
      ? parseChannelConfig(
          row.type,
          restoreChannelConfig(row.type, patch.config, row.config),
        )
      : row.config;
    const updated = await this.db.row<ChannelRow>(
      `UPDATE notification_channels
          SET name = $3, config = $4::jsonb, enabled = $5, updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [
        id,
        auth.orgId,
        patch.name ?? row.name,
        JSON.stringify(config),
        patch.enabled ?? row.enabled,
      ],
    );
    if (!updated) throw notFound('Channel');
    return toChannelView(updated);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    await this.require(auth.orgId, id);
    const rules = await this.db.rows<{ name: string }>(
      'SELECT name FROM alert_rules WHERE org_id = $1 AND $2::uuid = ANY(channel_ids) ORDER BY name',
      [auth.orgId, id],
    );
    const policies = await this.db.rows<{ name: string }>(
      `SELECT name FROM escalation_policies WHERE org_id = $1 AND steps @> $2::jsonb ORDER BY name`,
      [auth.orgId, JSON.stringify([{ channelIds: [id] }])],
    );
    const serverRules = await this.db.rows<{ name: string }>(
      'SELECT name FROM server_rules WHERE org_id = $1 AND $2::uuid = ANY(channel_ids) ORDER BY name',
      [auth.orgId, id],
    );
    const users = [
      ...rules.map((r) => `rule "${r.name}"`),
      ...serverRules.map((r) => `server rule "${r.name}"`),
      ...policies.map((p) => `policy "${p.name}"`),
    ];
    if (users.length > 0) throw inUse('This channel', users);
    await this.db.run(
      'DELETE FROM notification_channels WHERE id = $1 AND org_id = $2',
      [id, auth.orgId],
    );
  }

  async test(
    auth: AuthContext,
    body: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const input = parseWith(channelTestSchema, body);
    if (!this.limiter.attempt(`test:${auth.user.id}`, 10, 60_000)) {
      throw new HttpException(
        'Too many test messages. Wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let type: ChannelType;
    let config: Record<string, any>;
    let name = 'this channel';
    let channelId: string | null = null;

    if (input.channelId) {
      const row = await this.require(auth.orgId, input.channelId);
      channelId = row.id;
      type = row.type;
      name = row.name;
      config = input.config
        ? parseChannelConfig(
            row.type,
            restoreChannelConfig(row.type, input.config, row.config),
          )
        : row.config;
    } else {
      if (!input.type || !input.config)
        throw new BadRequestException(
          'Choose a channel type and fill in its settings',
        );
      type = input.type;
      config = parseChannelConfig(type, input.config);
    }

    try {
      await deliver(
        type,
        config,
        testMessage(this.config.get('WEB_URL'), name),
        {
          blockPrivate: this.config.get('BLOCK_PRIVATE_TARGETS'),
          sendMail: (message) => this.mail.deliver(message),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (channelId) await this.markUsed(channelId, message);
      return { ok: false, error: message };
    }
    if (channelId) await this.markUsed(channelId, null);
    return { ok: true };
  }

  async assertUsable(orgId: string, ids: string[]): Promise<void> {
    await assertOwned(this.db, 'channels', orgId, ids);
  }

  private async markUsed(id: string, error: string | null): Promise<void> {
    await this.db.run(
      'UPDATE notification_channels SET last_used_at = now(), last_error = $2::text WHERE id = $1',
      [id, error],
    );
  }

  private async require(orgId: string, id: string): Promise<ChannelRow> {
    const row = await this.db.row<ChannelRow>(
      'SELECT * FROM notification_channels WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (!row) throw notFound('Channel');
    return row;
  }
}
