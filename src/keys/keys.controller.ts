import { Body, Controller, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { AccessClaims } from '../auth/token.service.js';
import { CurrentAuth } from '../common/auth.guard.js';
import { base64, fromB64 } from '../common/base64.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import { KeysService } from './keys.service.js';

/** 33-byte Curve25519 public key with the 0x05 type prefix (44 base64 chars). */
const publicKey = base64({ exact: 44 }).refine((v) => {
  const b = fromB64(v);
  return b.length === 33 && b[0] === 0x05;
}, 'Must be a 33-byte public key starting with 0x05');
const keyId = z.int().min(0).max(16_777_215);

const uploadSchema = z.strictObject({
  registrationId: z.int().min(1).max(16_380),
  identityKey: publicKey,
  signedPreKey: z
    .strictObject({ keyId, publicKey, signature: base64({ exact: 88 }) })
    .optional(),
  preKeys: z.array(z.strictObject({ keyId, publicKey })).max(100),
});

const bundleQuery = z.object({
  // `?deviceId=a&deviceId=b` arrives as an array, a single one as a string.
  deviceId: z
    .preprocess((v) => (v === undefined ? undefined : [v].flat()), z.array(z.uuid()).min(1).max(5))
    .optional(),
});

@Controller()
export class KeysController {
  constructor(
    private readonly keys: KeysService,
    private readonly limits: RateLimitService,
  ) {}

  @Put('keys')
  @HttpCode(204)
  async upload(
    @CurrentAuth() auth: AccessClaims,
    @Body({ schema: uploadSchema }) body: z.infer<typeof uploadSchema>,
  ) {
    await this.keys.upload(auth.deviceId, body);
  }

  @Get('keys/count')
  async count(@CurrentAuth() auth: AccessClaims) {
    return { count: await this.keys.count(auth.deviceId) };
  }

  @Get('users/:userId/keys')
  async bundles(
    @CurrentAuth() auth: AccessClaims,
    @Param('userId', { schema: z.uuid() }) userId: string,
    @Query({ schema: bundleQuery }) query: z.infer<typeof bundleQuery>,
  ) {
    await this.limits.consume(`keys:${auth.deviceId}`, 120, 3600);
    return this.keys.bundles(auth, userId, query.deviceId);
  }
}
