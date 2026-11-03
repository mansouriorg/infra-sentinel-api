import { Module } from '@nestjs/common';
import { MonitorsModule } from '../monitors/monitors.module';
import { WebhookEmitter } from './webhook.emitter';
import { WebhookWorker } from './webhook.worker';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [MonitorsModule],
  controllers: [WebhooksController],
  providers: [WebhookEmitter, WebhookWorker, WebhooksService],
})
export class WebhooksModule {}
