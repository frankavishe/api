import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { AccessClaims } from '../auth/token.service.js';
import { CurrentAuth } from '../common/auth.guard.js';
import { base64 } from '../common/base64.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import { MessagesService } from './messages.service.js';

/** 64 members x (1 Android + 4 web) devices. */
export const MAX_ENVELOPES = 320;

const sendSchema = z.strictObject({
  conversationId: z.uuid(),
  envelopes: z
    .array(
      z.strictObject({
        deviceId: z.uuid(),
        type: z.enum(['prekey', 'whisper']),
        // At most 64 KiB of ciphertext before base64.
        ciphertext: base64({ min: 4, max: 87_384 }),
      }),
    )
    .max(MAX_ENVELOPES)
    .refine(
      (envs) => new Set(envs.map((e) => e.deviceId)).size === envs.length,
      'Only one envelope per device',
    ),
});

const pendingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const ackSchema = z.strictObject({ ids: z.array(z.uuid()).min(1).max(500) });

@Controller()
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly limits: RateLimitService,
  ) {}

  @Post('messages')
  @HttpCode(200)
  async send(
    @CurrentAuth() auth: AccessClaims,
    @Body({ schema: sendSchema }) body: z.infer<typeof sendSchema>,
  ) {
    await this.limits.consume(`msg:${auth.deviceId}`, 300, 60);
    return this.messages.send(auth, body.conversationId, body.envelopes);
  }

  @Get('envelopes')
  pending(
    @CurrentAuth() auth: AccessClaims,
    @Query({ schema: pendingQuery }) query: z.infer<typeof pendingQuery>,
  ) {
    return this.messages.pending(auth.deviceId, query.limit);
  }

  @Post('envelopes/ack')
  @HttpCode(204)
  async ack(@CurrentAuth() auth: AccessClaims, @Body({ schema: ackSchema }) body: z.infer<typeof ackSchema>) {
    await this.messages.ack(auth.deviceId, body.ids);
  }
}
