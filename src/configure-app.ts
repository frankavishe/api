import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { json, type NextFunction, type Request, type Response } from 'express';
import { Logger } from 'nestjs-pino';
import type { ErrorBody } from './common/errors.js';
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
  // POST /messages carries up to 320 ciphertexts of up to 64 KiB each. Registered before
  // Nest's default 100 kb parser (added at init), which then skips the already-parsed body.
  app.use('/v1/messages', largeJson);
  app.enableCors({ origin: webOrigin, credentials: true });
  app.useGlobalPipes(createValidationPipe());

  const io = new RedisIoAdapter(app, config.get('REDIS_URL', { infer: true }), webOrigin);
  await io.connectToRedis();
  app.useWebSocketAdapter(io);
}

const messagesJson = json({ limit: '30mb' });

/** Like express.json, but an oversized body becomes the API's 413 PAYLOAD_TOO_LARGE error. */
function largeJson(req: Request, res: Response, next: NextFunction) {
  messagesJson(req, res, (err?: unknown) => {
    if ((err as { type?: string } | undefined)?.type === 'entity.too.large') {
      const body: ErrorBody = { code: 'PAYLOAD_TOO_LARGE', message: 'Message is too large' };
      res.status(413).json(body);
      return;
    }
    next(err);
  });
}
