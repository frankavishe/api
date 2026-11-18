import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from './auth/token.service.js';
import { JwtAuthGuard } from './common/auth.guard.js';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { RateLimitService } from './common/rate-limit.service.js';
import type { Env } from './config/env.js';
import { DeviceStatusService } from './devices/device-status.service.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';
import { RealtimeService } from './realtime/realtime.service.js';

/** Cross-cutting providers every feature module uses. */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  providers: [
    TokenService,
    RateLimitService,
    DeviceStatusService,
    RealtimeGateway,
    RealtimeService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
  exports: [JwtModule, TokenService, RateLimitService, DeviceStatusService, RealtimeService],
})
export class CoreModule {}
