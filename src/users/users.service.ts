import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp, { type Metadata } from 'sharp';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../common/errors.js';
import type { Env } from '../config/env.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { StorageService } from '../storage/storage.service.js';
import { UserPresenter } from './user.presenter.js';

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const AVATAR_SIZE = 640;
const THUMB_SIZE = 96;

const avatarObjects = (key: string) => [`${key}.webp`, `${key}_thumb.webp`];

/** Profile reads and edits (US2). */
@Injectable()
export class UsersService {
  private readonly logger = new Logger('Users');
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeService,
    private readonly presenter: UserPresenter,
    config: ConfigService<Env, true>,
  ) {
    this.bucket = config.get('S3_BUCKET_AVATARS', { infer: true });
  }

  get(userId: string): Promise<User> {
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
  }

  async update(userId: string, patch: { displayName?: string; about?: string }): Promise<User> {
    const user = await this.prisma.user.update({ where: { id: userId }, data: patch });
    await this.broadcast(user);
    return user;
  }

  /** Checks the real image type, center-crops to squares and stores WebP versions. */
  async setAvatar(userId: string, file: Buffer): Promise<User> {
    let meta: Metadata;
    try {
      meta = await sharp(file).metadata();
    } catch {
      meta = {} as Metadata;
    }
    if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use a JPEG, PNG or WebP image');
    }

    const key = uuidv7();
    const [full, thumb] = await Promise.all(
      [AVATAR_SIZE, THUMB_SIZE].map((size) =>
        sharp(file).rotate().resize(size, size, { fit: 'cover' }).webp({ quality: 85 }).toBuffer(),
      ),
    );
    const [fullKey, thumbKey] = avatarObjects(key);
    await Promise.all([
      this.storage.put(this.bucket, fullKey, full, 'image/webp'),
      this.storage.put(this.bucket, thumbKey, thumb, 'image/webp'),
    ]);

    const previous = await this.get(userId);
    const user = await this.prisma.user.update({ where: { id: userId }, data: { avatarKey: key } });
    await this.removeObjects(previous.avatarKey);
    await this.broadcast(user);
    return user;
  }

  async deleteAvatar(userId: string): Promise<User> {
    const previous = await this.get(userId);
    const user = await this.prisma.user.update({ where: { id: userId }, data: { avatarKey: null } });
    await this.removeObjects(previous.avatarKey);
    await this.broadcast(user);
    return user;
  }

  private async removeObjects(key: string | null) {
    if (!key) return;
    await this.storage.delete(this.bucket, avatarObjects(key)).catch((err: unknown) => {
      this.logger.warn(`could not delete old avatar ${key}: ${String(err)}`);
    });
  }

  /** profile:updated goes to the user's devices and to everyone who has them as a contact. */
  private async broadcast(user: User) {
    const watchers = await this.prisma.contact.findMany({
      where: { contactUserId: user.id },
      select: { ownerId: true },
    });
    const pub = this.presenter.toPublic(user);
    this.realtime.profileUpdated([user.id, ...watchers.map((w) => w.ownerId)], {
      id: pub.id,
      displayName: pub.displayName,
      about: pub.about,
      avatarUrl: pub.avatarUrl,
      avatarThumbUrl: pub.avatarThumbUrl,
    });
  }
}
