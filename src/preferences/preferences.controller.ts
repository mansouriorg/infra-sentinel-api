import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole } from '../auth/decorators';
import { PreferencesService } from './preferences.service';
import type { PreferencesView } from './preferences.types';

@ApiTags('preferences')
@Controller('preferences')
@MinRole('viewer')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  @ApiOperation({ summary: 'Your language and notification choices' })
  get(@CurrentAuth() auth: AuthContext): Promise<PreferencesView> {
    return this.preferences.get(auth.user.id);
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change your language or which notifications you see',
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<PreferencesView> {
    return this.preferences.update(auth, body);
  }
}
