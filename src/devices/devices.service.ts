import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../common/errors.js';
import type { Device, DeviceType, RevokedReason, User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { DeviceStatusService } from './device-status.service.js';

export const MAX_WEB_DEVICES = 4;

export interface Registration {
  user: User;
  device: Device;
  isNewAccount: boolean;
  /** Devices signed out by this registration (replaced Android / evicted web). */
  revokedDeviceIds: string[];
}

export function toDeviceDto(d: Device, currentDeviceId: string) {
  return {
    id: d.id,
    type: d.type,
    name: d.name,
    createdAt: d.createdAt.toISOString(),
    lastActiveAt: d.lastActiveAt.toISOString(),
    current: d.id === currentDeviceId,
  };
}

/** Device limits (FR-005) and sign-out (FR-009). */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly status: DeviceStatusService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Creates the account if needed; any other Android device is signed out as `replaced`. */
  async registerAndroid(phone: string, name: string): Promise<Registration> {
    const result = await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO users (id, phone_e164, updated_at)
        VALUES (${uuidv7()}::uuid, ${phone}, now())
        ON CONFLICT (phone_e164) DO NOTHING
        RETURNING id`;
      // Serialise device changes for this user.
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM users WHERE phone_e164 = ${phone} FOR UPDATE`;
      return this.addDevice(tx, locked.id, 'android', name, inserted.length === 1);
    });
    await this.afterRevocations(result.revokedDeviceIds, 'replaced');
    return result;
  }

  /** Web never creates accounts; a 5th web device evicts the least recently active one. */
  async registerWeb(phone: string, name: string): Promise<Registration> {
    const result = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM users WHERE phone_e164 = ${phone} FOR UPDATE`;
      if (!locked) {
        throw AppError.notFound(
          'ACCOUNT_NOT_FOUND',
          'No account for this number. Create your account on the Android app first.',
        );
      }
      return this.addDevice(tx, locked.id, 'web', name, false);
    });
    await this.afterRevocations(result.revokedDeviceIds, 'evicted');
    return result;
  }

  private async addDevice(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    userId: string,
    type: DeviceType,
    name: string,
    isNewAccount: boolean,
  ): Promise<Registration> {
    const active = await tx.device.findMany({
      where: { userId, type, revokedAt: null },
      orderBy: { lastActiveAt: 'asc' },
      select: { id: true },
    });
    const keep = type === 'android' ? 0 : MAX_WEB_DEVICES - 1;
    const toRevoke = active.slice(0, Math.max(active.length - keep, 0)).map((d) => d.id);
    if (toRevoke.length > 0) {
      await tx.device.updateMany({
        where: { id: { in: toRevoke } },
        data: { revokedAt: new Date(), revokedReason: type === 'android' ? 'replaced' : 'evicted' },
      });
    }
    const device = await tx.device.create({ data: { id: uuidv7(), userId, type, name } });
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    return { user, device, isNewAccount, revokedDeviceIds: toRevoke };
  }

  private async afterRevocations(ids: string[], reason: RevokedReason) {
    for (const id of ids) {
      await this.status.markRevoked(id);
      this.realtime.deviceRevoked(id, reason);
    }
  }

  /** Signs a device out. Idempotent. */
  async revoke(deviceId: string, reason: RevokedReason): Promise<void> {
    const res = await this.prisma.device.updateMany({
      where: { id: deviceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.status.markRevoked(deviceId);
    if (res.count > 0) this.realtime.deviceRevoked(deviceId, reason);
  }

  async list(userId: string): Promise<Device[]> {
    return this.prisma.device.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastActiveAt: 'desc' },
    });
  }

  /** Signs out one of the user's own devices (US4). */
  async revokeOwn(userId: string, deviceId: string): Promise<void> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, userId, revokedAt: null },
      select: { id: true },
    });
    if (!device) throw AppError.notFound('DEVICE_NOT_FOUND', 'Device not found');
    await this.revoke(deviceId, 'signed_out');
  }
}
