import { Module } from '@nestjs/common';
import { ConditionalModule, ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { type Env, validateEnv } from './config/env.js';
import { CoreModule } from './core.module.js';
import { DevOtpModule } from './auth/sms/sms-sender.js';
import { AuthModule, ContactsModule } from './feature.modules.js';
import { HealthModule } from './health.controller.js';
import { PrismaModule } from './prisma/prisma.service.js';
import { RedisModule } from './redis/redis.module.js';
import { StorageModule } from './storage/storage.service.js';

/** Fields that must never reach the logs (tokens, cookies, one-time codes). */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.accessToken',
  '*.refreshToken',
  '*.code',
  '*.token',
];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const env = config.get('NODE_ENV', { infer: true });
        return {
          pinoHttp: {
            level: env === 'test' ? 'silent' : env === 'production' ? 'info' : 'debug',
            redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
            transport:
              env === 'development'
                ? { target: 'pino-pretty', options: { singleLine: true } }
                : undefined,
          },
        };
      },
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    StorageModule,
    CoreModule,
    AuthModule,
    ContactsModule,
    HealthModule,
    // Dev-only helper endpoint; never registered in test or production. Checked after
    // ConfigModule has loaded .env, so NODE_ENV from .env counts (not just the shell's).
    ConditionalModule.registerWhen(DevOtpModule, (env) => env.NODE_ENV === 'development'),
  ],
})
export class AppModule {}
