import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import {
  invitationMessage,
  noticeMessage,
  resetPasswordMessage,
  securityNoticeMessage,
  verifyEmailMessage,
  type MailMessage,
} from './mail.templates';

interface Transport {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transport?: Transport;

  constructor(private readonly config: AppConfig) {}

  async deliver(message: MailMessage): Promise<void> {
    await this.getTransport().sendMail({
      from: this.config.get('MAIL_FROM'),
      ...message,
    });
  }

  async send(message: MailMessage): Promise<boolean> {
    try {
      await this.deliver(message);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Could not send "${message.subject}" to ${message.to}: ${reason}`,
      );
      return false;
    }
  }

  sendVerification(to: string, name: string, url: string): Promise<boolean> {
    return this.send(verifyEmailMessage(to, name, url));
  }

  sendPasswordReset(to: string, name: string, url: string): Promise<boolean> {
    return this.send(resetPasswordMessage(to, name, url));
  }

  sendInvitation(
    to: string,
    inviter: string,
    organization: string,
    role: string,
    url: string,
  ): Promise<boolean> {
    return this.send(invitationMessage(to, inviter, organization, role, url));
  }

  sendNotice(
    to: string,
    name: string,
    heading: string,
    detail: string,
    url: string,
    label: string,
  ): Promise<boolean> {
    return this.send(
      noticeMessage(
        to,
        name,
        heading,
        detail,
        url,
        label,
        'You are receiving this because you are an administrator of this organization.',
      ),
    );
  }

  sendSecurityNotice(
    to: string,
    name: string,
    heading: string,
    detail: string,
    url: string,
  ): Promise<boolean> {
    return this.send(securityNoticeMessage(to, name, heading, detail, url));
  }

  private getTransport(): Transport {
    if (!this.transport) {
      const { createTransport } = require('nodemailer') as {
        createTransport: (options: Record<string, unknown>) => Transport;
      };
      const user = this.config.get('SMTP_USER');
      this.transport = createTransport({
        host: this.config.get('SMTP_HOST'),
        port: this.config.get('SMTP_PORT'),
        secure: this.config.get('SMTP_SECURE'),
        auth: user ? { user, pass: this.config.get('SMTP_PASS') } : undefined,
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
      });
    }
    return this.transport;
  }
}
