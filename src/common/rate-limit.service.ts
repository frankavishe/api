import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module.js';
import { AppError } from './errors.js';

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (only meaningful when blocked). */
  retryAfter: number;
}

/** Fixed-window counters in Redis. */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const k = `rl:${key}`;
    // Start a window if none exists, then count this request in it.
    await this.redis.set(k, '0', 'EX', windowSeconds, 'NX');
    const count = await this.redis.incr(k);
    if (count <= limit) return { allowed: true, retryAfter: 0 };
    const ttlMs = await this.redis.pttl(k);
    const retryAfter = ttlMs > 0 ? Math.ceil(ttlMs / 1000) : windowSeconds;
    return { allowed: false, retryAfter };
  }

  /** Like hit(), but throws 429 RATE_LIMITED when the limit is exceeded. */
  async consume(key: string, limit: number, windowSeconds: number): Promise<void> {
    const res = await this.hit(key, limit, windowSeconds);
    if (!res.allowed) throw AppError.rateLimited(res.retryAfter);
  }
}
