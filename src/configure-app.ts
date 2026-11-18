import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { createValidationPipe } from './common/http-error.filter.js';
import type { Env } from './config/env.js';
import { RedisIoAdapter } from './realtime/redis-io.adapter.js';

/** Shared by main.ts and the e2e tests so both run the same HTTP/socket setup. */
export async function configureApp(app: INestApplication): Promise<void> {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const webOrigin = config.get('WEB_ORIGIN', { infer: true });

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('v1');
  app.use(cookieParser());
  app.enableCors({ origin: webOrigin, credentials: true });
  app.useGlobalPipes(createValidationPipe());

  const io = new RedisIoAdapter(app, config.get('REDIS_URL', { infer: true }), webOrigin);
  await io.connectToRedis();
  app.useWebSocketAdapter(io);
}
