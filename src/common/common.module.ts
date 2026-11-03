import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { RateLimits } from './rate-limits';
import { SecretBox } from './secret-box';

@Global()
@Module({
  providers: [
    {
      provide: SecretBox,
      useFactory: (config: AppConfig) =>
        new SecretBox(config.get('APP_SECRET')),
      inject: [AppConfig],
    },
    { provide: RateLimits, useFactory: () => new RateLimits() },
  ],
  exports: [SecretBox, RateLimits],
})
export class CommonModule {}
