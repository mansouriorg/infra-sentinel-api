import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { API_PREFIX, configureApp } from './app.setup';
import { AppConfig } from './config/app-config';
import { JsonLogger } from './metrics/json-logger';

async function bootstrap() {
  const app = await NestFactory.create(
    AppModule,
    process.env.LOG_FORMAT === 'json'
      ? { logger: new JsonLogger() }
      : undefined,
  );
  configureApp(app);

  const swagger = new DocumentBuilder()
    .setTitle('Infra Sentinel API')
    .setDescription(
      'Open-source infrastructure monitoring. Sign in with a session cookie, or send an API key as Authorization: Bearer isk_... Keys are created in Settings under Developers and are limited by scope. Answers carry X-RateLimit headers.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .addCookieAuth('sentinel_session')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  const port = app.get(AppConfig).get('PORT');
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`API  -> http://localhost:${port}/${API_PREFIX}`);
  logger.log(`Docs -> http://localhost:${port}/docs`);
}

void bootstrap();
