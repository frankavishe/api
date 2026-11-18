import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../common/errors.js';
import { DevicesService } from '../devices/devices.service.js';
import type { Device } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenService } from './token.service.js';

export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const revoked = () => AppError.unauthorized('SESSION_REVOKED', 'This device has been signed out');

/** Device-bound refresh tokens with rotation and reuse detection (R4). */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly devices: DevicesService,
  ) {}

  async create(deviceId: string): Promise<{ refreshToken: string }> {
    const { token, hash } = this.tokens.newRefreshToken();
    await this.prisma.session.create({
      data: {
        id: uuidv7(),
        deviceId,
        refreshHash: hash,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return { refreshToken: token };
  }

  async rotate(refreshToken: string): Promise<{ device: Device; refreshToken: string }> {
    const session = await this.prisma.session.findUnique({
      where: { refreshHash: this.tokens.hashRefresh(refreshToken) },
      include: { device: true },
    });
    if (!session || session.device.revokedAt) throw revoked();

    if (session.rotatedAt) {
      // An old token came back: assume it was stolen and end the device's session.
      await this.devices.revoke(session.deviceId, 'token_reuse');
      throw revoked();
    }
    if (session.expiresAt <= new Date()) {
      await this.devices.revoke(session.deviceId, 'inactive');
      throw revoked();
    }

    const { token, hash } = this.tokens.newRefreshToken();
    const rotated = await this.prisma.$transaction(async (tx) => {
      const marked = await tx.session.updateMany({
        where: { id: session.id, rotatedAt: null },
        data: { rotatedAt: new Date() },
      });
      if (marked.count !== 1) return false;
      await tx.session.create({
        data: {
          id: uuidv7(),
          deviceId: session.deviceId,
          refreshHash: hash,
          expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        },
      });
      return true;
    });
    if (!rotated) {
      // Lost a race with another use of the same token: treat as reuse.
      await this.devices.revoke(session.deviceId, 'token_reuse');
      throw revoked();
    }
    return { device: session.device, refreshToken: token };
  }
}
