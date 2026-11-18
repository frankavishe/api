import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import type { User } from '../generated/prisma/client.js';

/** Maps users to the contract's PublicUser / Me shapes. */
@Injectable()
export class UserPresenter {
  private readonly base: string;

  constructor(config: ConfigService<Env, true>) {
    this.base = `${config.get('PUBLIC_URL', { infer: true }).replace(/\/$/, '')}/v1/avatars`;
  }

  avatarUrls(avatarKey: string | null) {
    if (!avatarKey) return { avatarUrl: null, avatarThumbUrl: null };
    return {
      avatarUrl: `${this.base}/${avatarKey}.webp`,
      avatarThumbUrl: `${this.base}/${avatarKey}_thumb.webp`,
    };
  }

  toPublic(u: User) {
    return {
      id: u.id,
      phone: u.phoneE164,
      displayName: u.displayName,
      about: u.about,
      ...this.avatarUrls(u.avatarKey),
    };
  }

  toMe(u: User) {
    return { ...this.toPublic(u), profileComplete: u.displayName !== null };
  }
}
