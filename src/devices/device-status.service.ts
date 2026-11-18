import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS } from '../redis/redis.module.js';

const STATUS_TTL = 30;
const TOUCH_INTERVAL = 60;

/** Cached "is this device still signed in?" checks used on every request and socket. */
@Injectable()
export class DeviceStatusService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async isActive(deviceId: string): Promise<boolean> {
    const key = `dev:status:${deviceId}`;
    const cached = await this.redis.get(key);
    if (cached) return cached === 'active';
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { revokedAt: true },
    });
    const active = !!device && device.revokedAt === null;
    await this.redis.set(key, active ? 'active' : 'revoked', 'EX', STATUS_TTL);
    return active;
  }

  /** Call after revoking a device so the next check sees it immediately. */
  async markRevoked(deviceId: string): Promise<void> {
    await this.redis.set(`dev:status:${deviceId}`, 'revoked', 'EX', STATUS_TTL);
  }

  /** Updates last_active_at at most once a minute per device. */
  async touch(deviceId: string): Promise<void> {
    const first = await this.redis.set(`dev:touch:${deviceId}`, '1', 'EX', TOUCH_INTERVAL, 'NX');
    if (first !== 'OK') return;
    await this.prisma.device.updateMany({
      where: { id: deviceId, revokedAt: null },
      data: { lastActiveAt: new Date() },
    });
  }
}
