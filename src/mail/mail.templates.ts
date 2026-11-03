export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(
  heading: string,
  paragraphs: string[],
  action: { label: string; url: string },
  footer: string,
): string {
  const body = paragraphs
    .map(
      (p) => `<p style="margin:0 0 16px;line-height:1.55">${escapeHtml(p)}</p>`,
    )
    .join('');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0e1621">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>
${body}
<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#0e7490;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#5a6577">Or paste this link into your browser:<br>${escapeHtml(action.url)}</p>
<p style="margin:16px 0 0;font-size:13px;color:#5a6577">${escapeHtml(footer)}</p>
</div>`;
}

export function verifyEmailMessage(
  to: string,
  name: string,
  url: string,
): MailMessage {
  const lines = [
    `Hi ${name},`,
    'Confirm your email address to finish setting up your Infra Sentinel account.',
  ];
  return {
    to,
    subject: 'Confirm your email address',
    text: `${lines.join('\n\n')}\n\n${url}\n\nThis link is valid for 24 hours.`,
    html: layout(
      'Confirm your email',
      lines,
      { label: 'Confirm email', url },
      'This link is valid for 24 hours.',
    ),
  };
}

export function resetPasswordMessage(
  to: string,
  name: string,
  url: string,
): MailMessage {
  const lines = [
    `Hi ${name},`,
    'Someone asked to reset the password for your Infra Sentinel account. If that was you, choose a new password with the button below.',
  ];
  const footer =
    'This link is valid for 1 hour. If you did not ask for it, you can ignore this email.';
  return {
    to,
    subject: 'Reset your password',
    text: `${lines.join('\n\n')}\n\n${url}\n\n${footer}`,
    html: layout(
      'Reset your password',
      lines,
      { label: 'Choose a new password', url },
      footer,
    ),
  };
}

export function invitationMessage(
  to: string,
  inviter: string,
  organization: string,
  role: string,
  url: string,
): MailMessage {
  const lines = [
    `${inviter} invited you to join ${organization} on Infra Sentinel as ${role}.`,
  ];
  const footer = 'This invitation is valid for 7 days.';
  return {
    to,
    subject: `${inviter} invited you to ${organization}`,
    text: `${lines.join('\n\n')}\n\n${url}\n\n${footer}`,
    html: layout(
      `Join ${organization}`,
      lines,
      { label: 'Accept invitation', url },
      footer,
    ),
  };
}

export function noticeMessage(
  to: string,
  name: string,
  heading: string,
  detail: string,
  url: string,
  label: string,
  footer: string,
): MailMessage {
  const lines = [`Hi ${name},`, detail];
  return {
    to,
    subject: heading,
    text: `${lines.join('\n\n')}\n\n${url}\n\n${footer}`,
    html: layout(heading, lines, { label, url }, footer),
  };
}

export function securityNoticeMessage(
  to: string,
  name: string,
  heading: string,
  detail: string,
  url: string,
): MailMessage {
  return noticeMessage(
    to,
    name,
    heading,
    detail,
    url,
    'Review security settings',
    'If this was not you, change your password and review your security settings right away.',
  );
}
