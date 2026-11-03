import {
  escapeHtml,
  invitationMessage,
  noticeMessage,
  securityNoticeMessage,
  resetPasswordMessage,
  verifyEmailMessage,
} from './mail.templates';

describe('mail templates', () => {
  it('escapes html', () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe(
      '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;',
    );
  });

  it('puts the link in both the text and html parts', () => {
    const url = 'http://localhost:3000/reset-password?token=abc';
    const message = resetPasswordMessage('ada@example.com', 'Ada', url);

    expect(message.to).toBe('ada@example.com');
    expect(message.text).toContain(url);
    expect(message.html).toContain(url);
  });

  it('never lets user-supplied names inject markup', () => {
    const message = invitationMessage(
      'b@example.com',
      '<script>alert(1)</script>',
      'Acme & Co',
      'member',
      'http://localhost:3000/invite/t',
    );

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('Acme &amp; Co');
  });

  it('builds a verification email', () => {
    const message = verifyEmailMessage(
      'a@example.com',
      'Ada',
      'http://x/verify',
    );
    expect(message.subject).toMatch(/email/i);
    expect(message.text).toContain('http://x/verify');
  });

  it('writes notices with a button and a footer, and escapes the details', () => {
    const message = noticeMessage(
      'a@example.com',
      '<b>Ada</b>',
      'Heads up',
      'It broke <script>',
      'http://x.test/settings',
      'Open it',
      'Footer text',
    );
    expect(message.subject).toBe('Heads up');
    expect(message.text).toContain('http://x.test/settings');
    expect(message.text).toContain('Footer text');
    expect(message.html).toContain('Open it');
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toContain('<b>Ada</b>');
  });

  it('tells people what to do if a security change was not theirs', () => {
    const message = securityNoticeMessage(
      'a@example.com',
      'Ada',
      'Two-factor authentication is on',
      'Detail',
      'http://x.test/settings',
    );
    expect(message.text).toContain('change your password');
    expect(message.html).toContain('Review security settings');
  });
});
