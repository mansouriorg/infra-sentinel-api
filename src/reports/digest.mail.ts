import { escapeHtml, type MailMessage } from '../mail/mail.templates';
import { formatAvailability, formatSpan } from './availability';
import type { SlaReport } from './report.types';

const MAX_ROWS = 12;
const MAX_INCIDENTS = 8;

function tone(value: number | null, target: number): string {
  if (value === null) return '#5a6577';
  return value * 100 >= target ? '#15803d' : '#b91c1c';
}

export function digestMessage(
  to: string,
  report: SlaReport,
  reportUrl: string,
): MailMessage {
  const summary = report.summary;
  const availability = formatAvailability(summary.availability);
  const count = summary.incidents;
  const subject = `Weekly report for ${report.organization}: ${availability} available, ${count} ${count === 1 ? 'incident' : 'incidents'}`;
  const downtime = formatSpan(summary.downtimeSec * 1000);
  const rows = report.rows.slice(0, MAX_ROWS);
  const incidents = report.incidents.slice(0, MAX_INCIDENTS);
  const hidden = report.rows.length - rows.length;
  const footer =
    'Scheduled maintenance and paused monitors are not counted as downtime. You get this email because you are a member of this workspace. An admin can change it under Reports, Weekly digest.';

  const stat = (label: string, value: string) =>
    `<td style="padding:12px 16px;background:#f1f4f7;border-radius:8px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#5a6577">${escapeHtml(label)}</div><div style="font-size:22px;font-weight:600;margin-top:4px">${escapeHtml(value)}</div></td>`;
  const tableRows = rows
    .map(
      (row) =>
        `<tr><td style="padding:8px 0;border-top:1px solid #e5e7eb">${escapeHtml(row.name)}</td><td style="padding:8px 0;border-top:1px solid #e5e7eb;text-align:right;font-weight:600;color:${tone(row.availability, report.target)}">${escapeHtml(formatAvailability(row.availability))}</td><td style="padding:8px 0 8px 16px;border-top:1px solid #e5e7eb;text-align:right;color:#5a6577">${escapeHtml(formatSpan(row.downtimeSec * 1000))}</td><td style="padding:8px 0 8px 16px;border-top:1px solid #e5e7eb;text-align:right;color:#5a6577">${row.incidents}</td></tr>`,
    )
    .join('');
  const incidentItems = incidents
    .map(
      (incident) =>
        `<li style="margin:0 0 6px">${escapeHtml(incident.subject)}: ${escapeHtml(incident.title)} <span style="color:#5a6577">(${escapeHtml(formatSpan(incident.durationSec * 1000))})</span></li>`,
    )
    .join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0e1621">
<h1 style="font-size:20px;margin:0 0 4px">Weekly report</h1>
<p style="margin:0 0 20px;color:#5a6577">${escapeHtml(report.organization)}, ${escapeHtml(report.period.label)}</p>
<table role="presentation" cellspacing="8" style="margin:0 -8px 12px;border-collapse:separate"><tr>${stat('Availability', availability)}${stat('Downtime', downtime)}${stat('Incidents', String(count))}</tr></table>
${
  rows.length > 0
    ? `<table role="presentation" width="100%" cellspacing="0" style="font-size:14px;border-collapse:collapse"><tr><th align="left" style="padding:6px 0;font-size:11px;text-transform:uppercase;color:#5a6577">Component</th><th align="right" style="padding:6px 0;font-size:11px;text-transform:uppercase;color:#5a6577">Availability</th><th align="right" style="padding:6px 0 6px 16px;font-size:11px;text-transform:uppercase;color:#5a6577">Downtime</th><th align="right" style="padding:6px 0 6px 16px;font-size:11px;text-transform:uppercase;color:#5a6577">Incidents</th></tr>${tableRows}</table>${hidden > 0 ? `<p style="font-size:13px;color:#5a6577">And ${hidden} more in the full report.</p>` : ''}`
    : '<p style="color:#5a6577">There are no monitors or servers yet.</p>'
}
${incidents.length > 0 ? `<h2 style="font-size:15px;margin:24px 0 8px">Incidents</h2><ul style="padding-left:18px;margin:0;font-size:14px">${incidentItems}</ul>` : '<p style="margin:20px 0 0">No incidents this week.</p>'}
<p style="margin:24px 0"><a href="${escapeHtml(reportUrl)}" style="background:#0e7490;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Open the full report</a></p>
<p style="margin:0;font-size:13px;color:#5a6577">${escapeHtml(footer)}</p>
</div>`;

  const textRows = rows.map(
    (row) =>
      `- ${row.name}: ${formatAvailability(row.availability)}, downtime ${formatSpan(row.downtimeSec * 1000)}, ${row.incidents} incidents`,
  );
  const textIncidents = incidents.map(
    (incident) =>
      `- ${incident.subject}: ${incident.title} (${formatSpan(incident.durationSec * 1000)})`,
  );
  const text = [
    `Weekly report for ${report.organization}`,
    report.period.label,
    '',
    `Availability ${availability}. Downtime ${downtime}. Incidents ${count}.`,
    '',
    ...textRows,
    ...(hidden > 0 ? [`And ${hidden} more in the full report.`] : []),
    '',
    textIncidents.length > 0 ? 'Incidents' : 'No incidents this week.',
    ...textIncidents,
    '',
    `Full report: ${reportUrl}`,
    '',
    footer,
  ].join('\n');

  return { to, subject, text, html };
}
