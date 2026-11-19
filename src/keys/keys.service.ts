import { Injectable } from '@nestjs/common';
import type { AccessClaims } from '../auth/token.service.js';
import { fromB64, toB64 } from '../common/base64.js';
import { AppError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';

/** Below this many unused one-time prekeys the device gets `prekeys:low`. */
export const PREKEY_LOW_WATERMARK = 10;

export interface UploadKeys {
  registrationId: number;
  identityKey: string;
  signedPreKey?: { keyId: number; publicKey: string; signature: string };
  preKeys: { keyId: number; publicKey: string }[];
}

export interface PublicPreKeyDto {
  keyId: number;
  publicKey: string;
}

export interface DeviceBundleDto {
  deviceId: string;
  registrationId: number;
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  preKey: PublicPreKeyDto | null;
}

/** Signal public key directory. The server never sees private keys. */
@Injectable()
export class KeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async upload(deviceId: string, body: UploadKeys): Promise<void> {
    const identityKey = fromB64(body.identityKey);
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.deviceKeys.findUnique({ where: { deviceId } });
      const replaced =
        existing !== null && !Buffer.from(existing.identityKey).equals(Buffer.from(identityKey));
      if ((existing === null || replaced) && !body.signedPreKey) {
        throw AppError.badRequest(
          'KEYS_NOT_UPLOADED',
          'The first key upload (or a new identity key) must include signedPreKey',
        );
      }
      if (replaced) {
        // A new identity invalidates every key signed by or bound to the old one.
        await tx.oneTimePreKey.deleteMany({ where: { deviceId } });
        await tx.signedPreKey.deleteMany({ where: { deviceId } });
      }
      await tx.deviceKeys.upsert({
        where: { deviceId },
        create: { deviceId, registrationId: body.registrationId, identityKey },
        update: { registrationId: body.registrationId, identityKey },
      });
      if (body.signedPreKey) {
        const spk = {
          keyId: body.signedPreKey.keyId,
          publicKey: fromB64(body.signedPreKey.publicKey),
          signature: fromB64(body.signedPreKey.signature),
        };
        await tx.signedPreKey.upsert({
          where: { deviceId },
          create: { deviceId, ...spk },
          update: { ...spk, createdAt: new Date() },
        });
      }
      if (body.preKeys.length > 0) {
        await tx.oneTimePreKey.createMany({
          data: body.preKeys.map((k) => ({ deviceId, keyId: k.keyId, publicKey: fromB64(k.publicKey) })),
          skipDuplicates: true,
        });
      }
    });
  }

  count(deviceId: string): Promise<number> {
    return this.prisma.oneTimePreKey.count({ where: { deviceId } });
  }

  /** One bundle per active, key-holding device of `userId`; consumes one one-time prekey each. */
  async bundles(caller: AccessClaims, userId: string, deviceIds?: string[]) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw AppError.notFound('USER_NOT_FOUND', 'User not found');

    const devices = await this.prisma.device.findMany({
      where: {
        userId,
        revokedAt: null,
        keys: { isNot: null },
        signedPreKey: { isNot: null },
        AND: [
          userId === caller.userId ? { id: { not: caller.deviceId } } : {},
          deviceIds ? { id: { in: deviceIds } } : {},
        ],
      },
      include: { keys: true, signedPreKey: true },
      orderBy: { createdAt: 'asc' },
    });

    const bundles: DeviceBundleDto[] = [];
    for (const d of devices) {
      // keys/signedPreKey are guaranteed by the `isNot: null` filter above.
      const keys = d.keys!;
      const spk = d.signedPreKey!;
      bundles.push({
        deviceId: d.id,
        registrationId: keys.registrationId,
        identityKey: toB64(keys.identityKey),
        signedPreKey: { keyId: spk.keyId, publicKey: toB64(spk.publicKey), signature: toB64(spk.signature) },
        preKey: await this.popPreKey(d.id),
      });
    }
    return { userId, devices: bundles };
  }

  /** Atomically takes the lowest-numbered one-time prekey; concurrent callers never get the same one. */
  private async popPreKey(deviceId: string): Promise<PublicPreKeyDto | null> {
    const rows = await this.prisma.$queryRaw<{ key_id: number; public_key: Uint8Array }[]>`
      DELETE FROM one_time_prekeys
      WHERE (device_id, key_id) = (
        SELECT device_id, key_id FROM one_time_prekeys
        WHERE device_id = ${deviceId}::uuid
        ORDER BY key_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING key_id, public_key`;
    const left = await this.count(deviceId);
    if (left < PREKEY_LOW_WATERMARK) this.realtime.prekeysLow(deviceId, left);
    const row = rows[0];
    return row ? { keyId: row.key_id, publicKey: toB64(row.public_key) } : null;
  }
}
