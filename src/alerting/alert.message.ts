import { escapeHtml, type MailMessage } from '../mail/mail.templates';
import { formatDuration } from './alert.scope';
import type {
  AlertMessage,
  IncidentStatus,
  Severity,
  Trigger,
} from './alert.types';

export interface IncidentContext {
  id: string;
  number: number;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  trigger: Trigger;
  startedAt: Date;
  resolvedAt: Date | null;
  cause: string;
  monitorId: string | null;
  monitorName: string;
  monitorTarget: string | null;
  baseUrl: string;
  source?: 'monitor' | 'server';
  serverId?: string | null;
  serverHost?: string | null;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

export function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function incidentUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/incidents/${id}`;
}

export function buildMessage(
  event: 'incident.opened' | 'incident.escalated' | 'incident.resolved',
  ctx: IncidentContext,
  now: Date = new Date(),
): AlertMessage {
  const lines: string[] = [];
  let title: string;

  const fromServer = ctx.source === 'server';
  if (event === 'incident.resolved') {
    title = fromServer
      ? `[RESOLVED] ${ctx.title}`
      : `[RESOLVED] ${ctx.monitorName} is back up`;
    const end = ctx.resolvedAt ?? now;
    lines.push(
      `Incident #${ctx.number} lasted ${formatDuration((end.getTime() - ctx.startedAt.getTime()) / 1000)}.`,
    );
    lines.push(`Started: ${stamp(ctx.startedAt)}`);
    lines.push(`Resolved: ${stamp(end)}`);
  } else {
    const label = SEVERITY_LABEL[ctx.severity].toUpperCase();
    const prefix =
      event === 'incident.escalated' ? `[ESCALATED ${label}]` : `[${label}]`;
    title = `${prefix} ${ctx.title}`;
    if (event === 'incident.escalated') {
      lines.push(
        `Incident #${ctx.number} has not been acknowledged after ${formatDuration((now.getTime() - ctx.startedAt.getTime()) / 1000)}.`,
      );
    } else {
      lines.push(
        `Incident #${ctx.number}, severity ${SEVERITY_LABEL[ctx.severity].toLowerCase()}.`,
      );
    }
    if (ctx.cause) lines.push(`Reason: ${ctx.cause}`);
    lines.push(`Started: ${stamp(ctx.startedAt)}`);
  }
  if (fromServer)
    lines.push(
      ctx.serverHost
        ? `Server: ${ctx.monitorName} (${ctx.serverHost})`
        : `Server: ${ctx.monitorName}`,
    );
  else if (ctx.monitorTarget)
    lines.push(`Monitor: ${ctx.monitorName} (${ctx.monitorTarget})`);

  return {
    event,
    severity: event === 'incident.resolved' ? 'info' : ctx.severity,
    title,
    lines,
    url: incidentUrl(ctx.baseUrl, ctx.id),
    incident: {
      id: ctx.id,
      number: ctx.number,
      status: ctx.status,
      startedAt: ctx.startedAt.toISOString(),
      resolvedAt: ctx.resolvedAt ? ctx.resolvedAt.toISOString() : null,
    },
    monitor:
      !fromServer && ctx.monitorId
        ? {
            id: ctx.monitorId,
            name: ctx.monitorName,
            target: ctx.monitorTarget,
          }
        : null,
    server:
      fromServer && ctx.serverId
        ? {
            id: ctx.serverId,
            name: ctx.monitorName,
            host: ctx.serverHost ?? null,
          }
        : null,
  };
}

export function testMessage(
  baseUrl: string,
  channelName: string,
): AlertMessage {
  return {
    event: 'test',
    severity: 'info',
    title: '[TEST] Infra Sentinel can reach this channel',
    lines: [`This is a test message for "${channelName}". Nothing is wrong.`],
    url: baseUrl.replace(/\/+$/, '') + '/alerts',
    incident: null,
    monitor: null,
    server: null,
  };
}

export function plainText(message: AlertMessage): string {
  const parts = [message.title, '', ...message.lines];
  if (message.url) parts.push('', message.url);
  return parts.join('\n');
}

const COLORS: Record<Severity, string> = {
  critical: '#dc2626',
  warning: '#d97706',
  info: '#0e7490',
};

export function severityColor(severity: Severity): string {
  return COLORS[severity];
}

export function renderEmail(message: AlertMessage, to: string): MailMessage {
  const color =
    message.event === 'incident.resolved'
      ? '#16a34a'
      : COLORS[message.severity];
  const body = message.lines
    .map(
      (line) =>
        `<p style="margin:0 0 12px;line-height:1.55">${escapeHtml(line)}</p>`,
    )
    .join('');
  const action = message.url
    ? `<p style="margin:24px 0"><a href="${escapeHtml(message.url)}" style="background:#0e7490;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Open in Infra Sentinel</a></p>`
    : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0e1621">
<div style="border-left:4px solid ${color};padding-left:12px;margin:0 0 20px"><h1 style="font-size:18px;margin:0">${escapeHtml(message.title)}</h1></div>
${body}${action}
<p style="margin:16px 0 0;font-size:12px;color:#5a6577">Sent by Infra Sentinel.</p>
</div>`;
  return { to, subject: message.title, text: plainText(message), html };
}
