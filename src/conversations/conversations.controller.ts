import { Body, Controller, Delete, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { AccessClaims } from '../auth/token.service.js';
import { CurrentAuth } from '../common/auth.guard.js';
import { ConversationsService } from './conversations.service.js';

const userIds = z
  .array(z.uuid())
  .min(1)
  .max(63)
  .refine((ids) => new Set(ids).size === ids.length, 'Ids must be unique');

const createSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('direct'), peerId: z.uuid() }),
  z.strictObject({ type: z.literal('group'), memberIds: userIds }),
]);
const addMembersSchema = z.strictObject({ userIds });

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@CurrentAuth() auth: AccessClaims) {
    return this.conversations.list(auth.userId);
  }

  /** 201 when created, 200 when an existing direct chat is returned. */
  @Post()
  async create(
    @CurrentAuth() auth: AccessClaims,
    @Body({ schema: createSchema }) body: z.infer<typeof createSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (body.type === 'direct') {
      const { conversation, created } = await this.conversations.createDirect(auth.userId, body.peerId);
      res.status(created ? 201 : 200);
      return conversation;
    }
    res.status(201);
    return this.conversations.createGroup(auth.userId, body.memberIds);
  }

  @Get(':conversationId')
  get(
    @CurrentAuth() auth: AccessClaims,
    @Param('conversationId', { schema: z.uuid() }) conversationId: string,
  ) {
    return this.conversations.get(conversationId, auth.userId);
  }

  @Post(':conversationId/members')
  @HttpCode(200)
  addMembers(
    @CurrentAuth() auth: AccessClaims,
    @Param('conversationId', { schema: z.uuid() }) conversationId: string,
    @Body({ schema: addMembersSchema }) body: z.infer<typeof addMembersSchema>,
  ) {
    return this.conversations.addMembers(conversationId, auth.userId, body.userIds);
  }

  @Delete(':conversationId/members/:userId')
  @HttpCode(204)
  async removeMember(
    @CurrentAuth() auth: AccessClaims,
    @Param('conversationId', { schema: z.uuid() }) conversationId: string,
    @Param('userId', { schema: z.uuid() }) userId: string,
  ) {
    await this.conversations.removeMember(conversationId, auth.userId, userId);
  }
}
