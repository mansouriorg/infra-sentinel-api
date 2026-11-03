import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from './auth.types';
import { CurrentAuth, MinRole } from './decorators';
import {
  TwoFactorService,
  type TwoFactorSetup,
  type TwoFactorStatus,
} from './two-factor.service';

@ApiTags('two-factor')
@Controller('two-factor')
export class TwoFactorController {
  constructor(private readonly twoFactor: TwoFactorService) {}

  @Get()
  @ApiOperation({ summary: 'Whether two-factor authentication is on for you' })
  status(@CurrentAuth() auth: AuthContext): Promise<TwoFactorStatus> {
    return this.twoFactor.status(auth);
  }

  @Post('setup')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start setup and get a secret for your authenticator app',
  })
  setup(@CurrentAuth() auth: AuthContext): Promise<TwoFactorSetup> {
    return this.twoFactor.setup(auth);
  }

  @Post('enable')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Confirm a code from your app and turn two-factor authentication on',
  })
  enable(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.twoFactor.enable(auth, body);
  }

  @Post('disable')
  @HttpCode(204)
  @ApiOperation({ summary: 'Turn two-factor authentication off' })
  disable(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<void> {
    return this.twoFactor.disable(auth, body);
  }

  @Post('recovery-codes')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create a new set of recovery codes' })
  regenerateRecoveryCodes(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.twoFactor.regenerateRecoveryCodes(auth, body);
  }

  @Delete('members/:userId')
  @MinRole('admin')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Turn off two-factor authentication for someone who lost their device',
  })
  resetMember(
    @CurrentAuth() auth: AuthContext,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<void> {
    return this.twoFactor.resetMember(auth, userId);
  }
}
