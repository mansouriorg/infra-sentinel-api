import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole } from '../auth/decorators';
import { NotificationsService } from './notifications.service';
import type { NoticePage } from './notifications.types';

@ApiTags('notifications')
@Controller('notifications')
@MinRole('viewer')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Your notifications for the active organization, newest first',
  })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: Record<string, string | undefined>,
  ): Promise<NoticePage> {
    return this.notifications.list(auth, query);
  }

  @Post('read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark some notifications (ids) or all of them (all: true) as read',
  })
  read(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ unread: number }> {
    return this.notifications.markRead(auth, body);
  }
}
