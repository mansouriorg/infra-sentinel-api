import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole } from '../auth/decorators';
import type { EventInfo } from './webhook.events';
import {
  WebhooksService,
  type DeliveryDetail,
  type DeliveryPage,
  type WebhookView,
} from './webhooks.service';

@ApiTags('webhooks')
@Controller('webhooks')
@MinRole('admin')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('events')
  @ApiOperation({ summary: 'Events a webhook can subscribe to' })
  events(): readonly EventInfo[] {
    return this.webhooks.events();
  }

  @Get()
  @ApiOperation({ summary: 'Webhooks of the active organization' })
  list(@CurrentAuth() auth: AuthContext): Promise<WebhookView[]> {
    return this.webhooks.list(auth);
  }

  @Post()
  @ApiOperation({ summary: 'Add a webhook. The signing secret is shown once.' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ endpoint: WebhookView; secret: string }> {
    return this.webhooks.create(auth, body);
  }

  @Get('deliveries/:deliveryId')
  @ApiOperation({ summary: 'One delivery, with the payload that was sent' })
  delivery(
    @CurrentAuth() auth: AuthContext,
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
  ): Promise<DeliveryDetail> {
    return this.webhooks.delivery(auth, deliveryId);
  }

  @Post('deliveries/:deliveryId/redeliver')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send an earlier event to the same webhook again' })
  redeliver(
    @CurrentAuth() auth: AuthContext,
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
  ): Promise<DeliveryDetail> {
    return this.webhooks.redeliver(auth, deliveryId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a webhook, or turn it on or off' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<WebhookView> {
    return this.webhooks.update(auth, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a webhook and its delivery log' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.webhooks.remove(auth, id);
  }

  @Post(':id/secret')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create a new signing secret. The old one stops working at once.',
  })
  rotateSecret(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ endpoint: WebhookView; secret: string }> {
    return this.webhooks.rotateSecret(auth, id);
  }

  @Post(':id/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a test event now and show the result' })
  test(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DeliveryDetail> {
    return this.webhooks.test(auth, id);
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'Recent deliveries to a webhook' })
  deliveries(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<DeliveryPage> {
    return this.webhooks.deliveries(auth, id, query);
  }
}
