import { Global, Module } from '@nestjs/common';
import { AppConfig } from './app-config';
import { loadEnv } from './env';

@Global()
@Module({
  providers: [
    { provide: AppConfig, useFactory: () => new AppConfig(loadEnv()) },
  ],
  exports: [AppConfig],
})
export class AppConfigModule {}
