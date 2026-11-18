import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { configureApp } from './configure-app.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  // Behind a reverse proxy in production; needed for per-IP rate limits.
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  await configureApp(app);
  app.enableShutdownHooks();

  if (
    config.get('NODE_ENV', { infer: true }) === 'production' &&
    config.get('SMS_PROVIDER', { infer: true }) === 'log'
  ) {
    new Logger('Bootstrap').warn(
      'STAGING MODE: ALLOW_LOG_SMS=true — one-time codes are written to the logs. Do not use with real users.',
    );
  }

  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
