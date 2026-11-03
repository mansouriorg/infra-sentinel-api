import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { API_PREFIX } from './common/api';
import { createCrossSiteGuard } from './common/cross-site';
import { AppConfig } from './config/app-config';
import { createMetricsMiddleware } from './metrics/metrics.http';
import { MetricsService } from './metrics/metrics.service';
import { DomainService } from './status/domain.service';
import { createStatusRouting } from './status/status.routing';

export { API_PREFIX };

export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfig);

  app.setGlobalPrefix(API_PREFIX);
  app.use(
    createMetricsMiddleware(
      app.get(MetricsService),
      config.get('METRICS_TOKEN'),
    ),
  );
  app.use(createCrossSiteGuard(API_PREFIX));
  app.use(createStatusRouting(app.get(DomainService), API_PREFIX));
  const proxies = config.get('TRUST_PROXY');
  if (proxies > 0) {
    app.getHttpAdapter().getInstance().set('trust proxy', proxies);
  }
  app.use(helmet({ contentSecurityPolicy: false }));
  app.enableCors({
    origin: config.get('WEB_URL'),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();
}
