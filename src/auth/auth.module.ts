import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { SessionsService } from './sessions.service';
import { TwoFactorController } from './two-factor.controller';
import { TwoFactorService } from './two-factor.service';

@Module({
  controllers: [AuthController, ApiKeysController, TwoFactorController],
  providers: [
    AuthService,
    SessionsService,
    ApiKeysService,
    TwoFactorService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionsService, ApiKeysService, TwoFactorService],
})
export class AuthModule {}
