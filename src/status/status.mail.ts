import { escapeHtml, type MailMessage } from '../mail/mail.templates';
import { STATE_LABELS } from './status.model';
import type { PublicIncident } from './status.types';

export type NotifyKind = 'opened' | 'update' | 'resolved';

function button(url: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#0e7490;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">${escapeHtml(label)}</a></p>`;
}

export function confirmationMessage(
  to: string,
  pageName: string,
  confirmUrl: string,
): MailMessage {
  const lines = [
    `Confirm that you want status updates for ${pageName}.`,
    'We will email you when an incident is created, updated or resolved. If you did not ask for this, ignore this email and nothing will happen.',
  ];
  return {
    to,
    subject: `Confirm your subscription to ${pageName}`,
    text: `${lines.join('\n\n')}\n\n${confirmUrl}`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0e1621">
<h1 style="font-size:20px;margin:0 0 16px">Confirm your subscription</h1>
${lines.map((line) => `<p style="margin:0 0 16px;line-height:1.55">${escapeHtml(line)}</p>`).join('')}
${button(confirmUrl, 'Confirm subscription')}
<p style="margin:0;font-size:13px;color:#5a6577">Or paste this link into your browser:<br>${escapeHtml(confirmUrl)}</p>
</div>`,
  };
}

export interface NotificationInput {
  to: string;
  kind: NotifyKind;
  pageName: string;
  incident: PublicIncident;
  pageUrl: string;
  unsubscribeUrl: string;
}

const PREFIX: Record<NotifyKind, string> = {
  opened: 'Incident',
  update: 'Update',
  resolved: 'Resolved',
};

export function notificationMessage(input: NotificationInput): MailMessage {
  const { incident } = input;
  const latest = incident.updates[0];
  const subject = `[${input.pageName}] ${PREFIX[input.kind]}: ${incident.title}`;
  const affects =
    incident.components.length > 0
      ? `Affects: ${incident.components.join(', ')}`
      : '';
  const history = incident.updates
    .slice(0, 5)
    .map(
      (update) =>
        `${STATE_LABELS[update.state]} (${update.at.slice(0, 16).replace('T', ' ')} UTC): ${update.message}`,
    );
  const text = [
    incident.title,
    `Status: ${STATE_LABELS[incident.state]}`,
    affects,
    '',
    latest ? latest.message : '',
    '',
    history.length > 1
      ? `Earlier updates\n${history.slice(1).join('\n')}\n`
      : '',
    `Status page: ${input.pageUrl}`,
    `Unsubscribe: ${input.unsubscribeUrl}`,
  ]
    .filter(
      (line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''),
    )
    .join('\n');
  const older = incident.updates
    .slice(1, 5)
    .map(
      (update) =>
        `<li style="margin:0 0 8px"><strong>${escapeHtml(STATE_LABELS[update.state])}</strong> <span style="color:#5a6577">${escapeHtml(update.at.slice(0, 16).replace('T', ' '))} UTC</span><br>${escapeHtml(update.message).replace(/\r?\n/g, '<br>')}</li>`,
    )
    .join('');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0e1621">
<p style="margin:0 0 4px;font-size:13px;color:#5a6577">${escapeHtml(input.pageName)}</p>
<h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(incident.title)}</h1>
<p style="margin:0 0 16px"><strong>${escapeHtml(STATE_LABELS[incident.state])}</strong>${affects ? ` <span style="color:#5a6577">&middot; ${escapeHtml(affects)}</span>` : ''}</p>
${latest ? `<p style="margin:0 0 16px;line-height:1.55">${escapeHtml(latest.message).replace(/\r?\n/g, '<br>')}</p>` : ''}
${older ? `<h2 style="font-size:14px;margin:24px 0 8px">Earlier updates</h2><ul style="padding-left:18px;margin:0;font-size:14px">${older}</ul>` : ''}
${button(input.pageUrl, 'View status page')}
<p style="margin:0;font-size:13px;color:#5a6577">You get this because you subscribed to ${escapeHtml(input.pageName)}. <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#5a6577">Unsubscribe</a></p>
</div>`;
  return {
    to: input.to,
    subject,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${input.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
