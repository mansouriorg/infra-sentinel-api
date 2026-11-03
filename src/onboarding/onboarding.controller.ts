import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole } from '../auth/decorators';
import { OnboardingService } from './onboarding.service';
import type { OnboardingView } from './onboarding.types';

@ApiTags('onboarding')
@Controller('onboarding')
@MinRole('admin')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @ApiOperation({ summary: 'Setup guide progress for the active organization' })
  view(@CurrentAuth() auth: AuthContext): Promise<OnboardingView> {
    return this.onboarding.view(auth);
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hide or show the setup guide for everyone in the organization',
  })
  setDismissed(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<OnboardingView> {
    return this.onboarding.setDismissed(auth, body);
  }
}
