import { createHmac } from 'node:crypto';
import type { MailMessage } from '../../mail/mail.templates';
import { escapeHtml } from '../../mail/mail.templates';
import { plainText, renderEmail, severityColor } from '../alert.message';
import type { AlertMessage, ChannelType, Severity } from '../alert.types';
import { postRequest, snippet, type PostResult } from './http-post';

export interface DeliveryContext {
  blockPrivate: boolean;
  sendMail: (message: MailMessage) => Promise<void>;
  timeoutMs?: number;
}

type Config = Record<string, any>;

function expectOk(result: PostResult, label: string): void {
  if (result.status >= 200 && result.status < 300) return;
  const detail = snippet(result.body);
  throw new Error(
    `${label} answered HTTP ${result.status}${detail ? `: ${detail}` : ''}`,
  );
}

function post(
  url: string,
  body: unknown,
  context: DeliveryContext,
  headers?: Record<string, string>,
) {
  return postRequest(url, {
    body: JSON.stringify(body),
    headers,
    blockPrivate: context.blockPrivate,
    timeoutMs: context.timeoutMs,
  });
}

async function sendEmail(
  config: Config,
  message: AlertMessage,
  context: DeliveryContext,
): Promise<void> {
  const recipients = (config.recipients as string[]) ?? [];
  const failures: string[] = [];
  for (const to of recipients) {
    try {
      await context.sendMail(renderEmail(message, to));
    } catch (error) {
      failures.push(
        `${to}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0)
    throw new Error(`Could not send email (${failures.join('; ')})`);
}

async function sendSlack(
  config: Config,
  message: AlertMessage,
  context: DeliveryContext,
): Promise<void> {
  const body = {
    text: plainText(message),
    attachments: [
      {
        color:
          message.event === 'incident.resolved'
            ? '#16a34a'
            : severityColor(message.severity),
        title: message.title,
        title_link: message.url ?? undefined,
        text: message.lines.join('\n'),
        footer: 'Infra Sentinel',
      },
    ],
  };
  expectOk(await post(config.webhookUrl, body, context), 'Slack');
}

const DISCORD_COLORS: Record<Severity, number> = {
  critical: 0xdc2626,
  warning: 0xd97706,
  info: 0x0e7490,
};

async function sendDiscord(
  config: Config,
  message: AlertMessage,
  context: DeliveryContext,
): Promise<void> {
  const body = {
    username: 'Infra Sentinel',
    embeds: [
      {
        title: message.title.slice(0, 256),
        url: message.url ?? undefined,
        description: message.lines.join('\n').slice(0, 4000),
        color:
          message.event === 'incident.resolved'
            ? 0x16a34a
            : DISCORD_COLORS[message.severity],
        timestamp: new Date().toISOString(),
      },
    ],
  };
  expectOk(await post(config.webhookUrl, body, context), 'Discord');
}

async function sendTelegram(
  config: Config,
  message: AlertMessage,
  context: DeliveryContext,
): Promise<void> {
  const base =
    (config.apiBaseUrl as string | undefined) ?? 'https://api.telegram.org';
  const lines = [
    `<b>${escapeHtml(message.title)}</b>`,
    ...message.lines.map((line) => escapeHtml(line)),
  ];
  if (message.url) lines.push(escapeHtml(message.url));
  const result = await post(
    `${base}/bot${config.botToken}/sendMessage`,
    {
      chat_id: config.chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    },
    context,
  );
  if (result.status >= 200 && result.status < 300) return;
  let reason = snippet(result.body);
  try {
    const parsed = JSON.parse(result.body) as { description?: string };
    if (parsed.description) reason = parsed.description;
  } catch {
    reason = snippet(result.body);
  }
  throw new Error(
    `Telegram answered HTTP ${result.status}${reason ? `: ${reason}` : ''}`,
  );
}

const NTFY_PRIORITY: Record<Severity, number> = {
  critical: 5,
  warning: 4,
  info: 3,
};

async function sendNtfy(
  config: Config,
  message: AlertMessage,
  context: DeliveryContext,
): Promise<void> {
  const tags =
    message.event === 'incident.resolved'
      ? ['white_check_mark']
      : message.event === 'test'
        ? ['bell']
        : message.severity === 'critical'
          ? ['rotating_light']
          : ['warning'];
  const body: Record<string, unknown> = {
    topic: config.topic,
    title: message.title,
    message: message.lines.join('\n'),
    priority:
      message.event === 'incident.resolved'
        ? 3
        : NTFY_PRIORITY[message.severity],
    tags,
  };
  if (message.url) body.click = message.url;
  const headers: Record<string, string> = {};
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  expectOk(await post(config.serverUrl, body, context, headers), 'ntfy');
}

const GOTIFY_PRIORITY: Record<Severity, number> = {
  critical: 8,
  warning: 5,
  info: 2,
};

async function sendGotify(
  config: Config,
  message: AlertMessage,
  context: DeliveryContext,
): Promise<void> {
  const body: Record<string, unknown> = {
    title: message.title,
    message: message.lines.join('\n'),
    priority:
      message.event === 'incident.resolved'
        ? 2
        : GOTIFY_PRIORITY[message.severity],
  };
  if (message.url)
    body.extras = { 'client::notification': { click: { url: message.url } } };
  expectOk(
    await post(`${config.serverUrl}/message`, body, context, {
      'x-gotify-key': config.appToken,
    }),
    'Gotify',
  );
}

export function webhookPayload(message: AlertMessage): Record<string, unknown> {
  return {
    event: message.event,
    severity: message.severity,
    title: message.title,
    summary: message.lines,
    url: message.url,
    incident: message.incident,
    monitor: message.monitor,
    server: message.server ?? null,
    sentAt: new Date().toISOString(),
  };
}

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function sendWebhook(
  config: Config,
  message: AlertMessage,
  context: DeliveryContext,
): Promise<void> {
  const body = JSON.stringify(webhookPayload(message));
  const headers: Record<string, string> = {
    ...(config.headers ?? {}),
    'x-sentinel-event': message.event,
  };
  if (config.secret)
    headers['x-sentinel-signature'] = signBody(config.secret, body);
  expectOk(
    await postRequest(config.url, {
      body,
      headers,
      blockPrivate: context.blockPrivate,
      timeoutMs: context.timeoutMs,
    }),
    'The webhook',
  );
}

const SENDERS: Record<
  ChannelType,
  (
    config: Config,
    message: AlertMessage,
    context: DeliveryContext,
  ) => Promise<void>
> = {
  email: sendEmail,
  slack: sendSlack,
  discord: sendDiscord,
  telegram: sendTelegram,
  ntfy: sendNtfy,
  gotify: sendGotify,
  webhook: sendWebhook,
};

export function deliver(
  type: ChannelType,
  config: Config,
  message: AlertMessage,
  context: DeliveryContext,
): Promise<void> {
  return SENDERS[type](config, message, context);
}
