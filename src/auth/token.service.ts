import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export type DeviceType = 'android' | 'web';

export interface AccessClaims {
  userId: string;
  deviceId: string;
  deviceType: DeviceType;
}

export const ACCESS_TTL_SECONDS = 15 * 60;

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  async signAccess(claims: AccessClaims): Promise<{ accessToken: string; expiresIn: number }> {
    const accessToken = await this.jwt.signAsync(
      { sub: claims.userId, did: claims.deviceId, dtype: claims.deviceType },
      { expiresIn: ACCESS_TTL_SECONDS },
    );
    return { accessToken, expiresIn: ACCESS_TTL_SECONDS };
  }

  /** Throws if the token is invalid, expired, or missing device claims. */
  async verifyAccess(token: string): Promise<AccessClaims> {
    const p = await this.jwt.verifyAsync<{ sub?: unknown; did?: unknown; dtype?: unknown }>(token);
    if (
      typeof p.sub !== 'string' ||
      typeof p.did !== 'string' ||
      (p.dtype !== 'android' && p.dtype !== 'web')
    ) {
      throw new Error('Malformed access token');
    }
    return { userId: p.sub, deviceId: p.did, deviceType: p.dtype };
  }

  /** 256-bit random refresh token; only its hash is stored. */
  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashRefresh(token) };
  }

  hashRefresh(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
