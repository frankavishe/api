import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DevicesService } from '../devices/devices.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** T067 — housekeeping: old one-time codes and devices inactive for 30 days (FR-006). */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger('Cleanup');

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async run(now = new Date()): Promise<{ otps: number; devices: number }> {
    const otps = await this.prisma.otpChallenge.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - DAY_MS) } },
    });
    const stale = await this.prisma.device.findMany({
      where: { revokedAt: null, lastActiveAt: { lt: new Date(now.getTime() - 30 * DAY_MS) } },
      select: { id: true },
    });
    for (const d of stale) await this.devices.revoke(d.id, 'inactive');
    if (otps.count || stale.length) {
      this.logger.log(`removed ${otps.count} old codes, signed out ${stale.length} inactive devices`);
    }
    return { otps: otps.count, devices: stale.length };
  }
}
