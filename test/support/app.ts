import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { inject } from 'vitest';
import { MINIO_PASSWORD, MINIO_USER } from './global-setup.js';

/** Captures codes instead of sending them. */
export class CapturingSms {
  readonly sent: { phone: string; code: string }[] = [];
  async sendCode(phone: string, code: string) {
    this.sent.push({ phone, code });
  }
  lastCode(phone: string): string {
    const hit = [...this.sent].reverse().find((s) => s.phone === phone);
    if (!hit) throw new Error(`no code sent to ${phone}`);
    return hit.code;
  }
}

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
  baseUrl: string;
  sms: CapturingSms;
  redis: Redis;
  get<T>(token: abstract new (...args: never[]) => T): T;
  socket(accessToken: string): Socket;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    WEB_ORIGIN: 'http://localhost:3001',
    DATABASE_URL: inject('DATABASE_URL'),
    REDIS_URL: inject('REDIS_URL'),
    S3_ENDPOINT: inject('S3_ENDPOINT'),
    S3_ACCESS_KEY: MINIO_USER,
    S3_SECRET_KEY: MINIO_PASSWORD,
    S3_BUCKET_AVATARS: 'avatars',
    JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
    OTP_PEPPER: 'e2e-pepper-e2e-pepper',
  });

  // Imported after env is set so module-level config sees test values.
  const { AppModule } = await import('../../src/app.module.js');
  const { configureApp } = await import('../../src/configure-app.js');
  const { SmsSender } = await import('../../src/auth/sms/sms-sender.js');
  const { REDIS } = await import('../../src/redis/redis.module.js');

  const sms = new CapturingSms();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SmsSender)
    .useValue(sms)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await configureApp(app);
  await app.listen(0);

  const redis = app.get<Redis>(REDIS);
  await redis.flushdb();

  const address = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sockets: Socket[] = [];

  return {
    app,
    http: request(app.getHttpServer()),
    baseUrl,
    sms,
    redis,
    get: (token) => app.get(token as never),
    socket(accessToken: string) {
      const s = io(`${baseUrl}/rt`, {
        auth: { token: accessToken },
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(s);
      return s;
    },
    async close() {
      sockets.forEach((s) => s.close());
      await app.close();
    },
  };
}

const phoneBase = Math.floor(Math.random() * 9_000_000);
let phoneCounter = 0;
/** Unique valid Tanzanian mobile numbers (+255 71x xxx xxx) per test run. */
export function newPhone(): string {
  phoneCounter += 1;
  return `+25571${String((phoneBase + phoneCounter) % 10_000_000).padStart(7, '0')}`;
}

/** Requests and verifies a code; returns the verify response body (plus web cookie if any). */
export async function signIn(
  t: TestApp,
  phone: string,
  deviceType: 'android' | 'web' = 'android',
  deviceName = deviceType === 'android' ? 'Pixel 8' : 'Chrome on Windows',
) {
  await t.http.post('/v1/auth/request-code').send({ phone }).expect(202);
  const res = await t.http
    .post('/v1/auth/verify')
    .send({ phone, code: t.sms.lastCode(phone), deviceType, deviceName });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { body: res.body, cookies: ([] as string[]).concat(res.headers['set-cookie'] ?? []) };
}

/** Resolves with the first payload of `event`, or rejects after `ms`. */
export function nextEvent<T = unknown>(socket: Socket, event: string, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

export function connected(socket: Socket, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not connect')), ms);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
