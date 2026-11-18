import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v7 as uuidv7 } from 'uuid';
import { RateLimitService } from '../common/rate-limit.service.js';
import { AppError } from '../common/errors.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SmsSender } from './sms/sms-sender.js';

export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_ATTEMPTS = 5;

/** One-time codes (FR-001..FR-003, FR-007). Only an HMAC of each code is stored. */
@Injectable()
export class OtpService {
  private readonly pepper: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsSender,
    private readonly limits: RateLimitService,
    config: ConfigService<Env, true>,
  ) {
    this.pepper = config.get('OTP_PEPPER', { infer: true });
  }

  private hmac(phone: string, code: string): string {
    return createHmac('sha256', this.pepper).update(`${phone}:${code}`).digest('hex');
  }

  /** Same response whether or not the number has an account (no enumeration). */
  async request(phone: string, ip?: string): Promise<{ expiresIn: number; resendAfter: number }> {
    if (ip) await this.limits.consume(`otp:ip:${ip}`, 20, 3600);
    await this.limits.consume(`otp:phone:${phone}:min`, 1, OTP_RESEND_SECONDS);
    await this.limits.consume(`otp:phone:${phone}:hour`, 5, 3600);

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const now = new Date();
    await this.prisma.$transaction([
      // A new code replaces any older one.
      this.prisma.otpChallenge.updateMany({
        where: { phoneE164: phone, consumedAt: null },
        data: { consumedAt: now },
      }),
      this.prisma.otpChallenge.create({
        data: {
          id: uuidv7(),
          phoneE164: phone,
          codeHmac: this.hmac(phone, code),
          expiresAt: new Date(now.getTime() + OTP_TTL_SECONDS * 1000),
        },
      }),
    ]);
    await this.sms.sendCode(phone, code);
    return { expiresIn: OTP_TTL_SECONDS, resendAfter: OTP_RESEND_SECONDS };
  }

  /** Resolves if the code is right; otherwise throws 401 with the specific reason. */
  async verify(phone: string, code: string): Promise<void> {
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phoneE164: phone, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) throw AppError.unauthorized('INVALID_CODE', 'The code is not valid');
    if (challenge.expiresAt <= new Date()) {
      throw AppError.unauthorized('CODE_EXPIRED', 'The code has expired, request a new one');
    }
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      throw AppError.unauthorized('TOO_MANY_ATTEMPTS', 'Too many attempts, request a new code');
    }

    const expected = Buffer.from(challenge.codeHmac, 'hex');
    const actual = Buffer.from(this.hmac(phone, code), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      const attempts = challenge.attempts + 1;
      const exhausted = attempts >= OTP_MAX_ATTEMPTS;
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts, consumedAt: exhausted ? new Date() : undefined },
      });
      if (exhausted) {
        throw AppError.unauthorized('TOO_MANY_ATTEMPTS', 'Too many attempts, request a new code');
      }
      throw AppError.unauthorized('INVALID_CODE', 'The code is not valid');
    }

    // Single use, even under concurrent verifies.
    const used = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (used.count !== 1) throw AppError.unauthorized('INVALID_CODE', 'The code is not valid');
  }
}
