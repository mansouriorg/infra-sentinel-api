import { Module } from '@nestjs/common';
import { AlertingModule } from './alerting/alerting.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { MetricsModule } from './metrics/metrics.module';
import { MonitorsModule } from './monitors/monitors.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OrgsModule } from './orgs/orgs.module';
import { PreferencesModule } from './preferences/preferences.module';
import { ReportsModule } from './reports/reports.module';
import { ServersModule } from './servers/servers.module';
import { SsoModule } from './sso/sso.module';
import { StatusModule } from './status/status.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    AppConfigModule,
    CommonModule,
    DatabaseModule,
    MailModule,
    AuditModule,
    AuthModule,
    SsoModule,
    OrgsModule,
    MonitorsModule,
    AlertingModule,
    ServersModule,
    ReportsModule,
    StatusModule,
    WebhooksModule,
    NotificationsModule,
    PreferencesModule,
    OnboardingModule,
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}
