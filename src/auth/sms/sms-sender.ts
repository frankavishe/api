import { Controller, Get, Inject, Injectable, Logger, Module, Query } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { Public } from '../../common/auth.guard.js';
import { AppError } from '../../common/errors.js';
import { E164_PATTERN } from '../../common/phone.js';
import { REDIS } from '../../redis/redis.module.js';

/** Delivers one-time codes. Replace the provider binding to add a real SMS gateway (FR-003). */
export abstract class SmsSender {
  abstract sendCode(phoneE164: string, code: string): Promise<void>;
}

const devKey = (phone: string) => `dev:otp:${phone}`;

/**
 * Development only: writes the code to the API log and keeps the latest one for
 * GET /v1/dev/last-otp (used by Playwright). Refused in production by env validation.
 */
@Injectable()
export class LogSmsSender extends SmsSender {
  private readonly logger = new Logger('OTP');

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    super();
  }

  async sendCode(phoneE164: string, code: string): Promise<void> {
    this.logger.warn(`OTP for ${phoneE164}: ${code}`);
    await this.redis.set(devKey(phoneE164), code, 'EX', 300);
  }
}

@Controller('dev')
class DevOtpController {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  @Public()
  @Get('last-otp')
  async lastOtp(@Query('phone', { schema: z.string().regex(E164_PATTERN) }) phone: string) {
    const code = await this.redis.get(devKey(phone));
    if (!code) throw AppError.notFound('USER_NOT_FOUND', 'No code sent to this number recently');
    return { code };
  }
}

/** Only imported when NODE_ENV=development (see app.module.ts). */
@Module({ controllers: [DevOtpController] })
export class DevOtpModule {}
