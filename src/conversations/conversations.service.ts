import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type ConversationPayload, RealtimeService } from '../realtime/realtime.service.js';

/** Groups hold at most this many members, the caller included (pairwise fan-out cost). */
export const MAX_GROUP_MEMBERS = 64;

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

const withMembers = {
  members: { orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }] },
} as const satisfies Prisma.ConversationInclude;

type ConversationWithMembers = Prisma.ConversationGetPayload<{ include: typeof withMembers }>;

export function toConversationDto(c: ConversationWithMembers): ConversationPayload {
  return {
    id: c.id,
    type: c.type,
    createdAt: c.createdAt.toISOString(),
    members: c.members.map((m) => ({
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
    })),
  };
}

const notFound = () => AppError.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
const tooLarge = () =>
  AppError.badRequest('GROUP_TOO_LARGE', `Groups hold at most ${MAX_GROUP_MEMBERS} members`);
const fixedMembers = () =>
  AppError.badRequest('VALIDATION_FAILED', 'Direct conversations have fixed members');

/**
 * Conversation membership. The server only knows who is in a conversation;
 * names and other metadata travel end-to-end encrypted as `group_update` payloads.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(userId: string): Promise<ConversationPayload[]> {
    const rows = await this.prisma.conversation.findMany({
      where: { members: { some: { userId } } },
      include: withMembers,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toConversationDto);
  }

  /** Non-members get 404 so they cannot probe which conversations exist. */
  async get(conversationId: string, userId: string): Promise<ConversationPayload> {
    const c = await this.prisma.conversation.findFirst({
      where: { id: conversationId, members: { some: { userId } } },
      include: withMembers,
    });
    if (!c) throw notFound();
    return toConversationDto(c);
  }

  /** Idempotent: returns `created: false` with the existing chat when there is one. */
  async createDirect(userId: string, peerId: string) {
    if (peerId === userId) {
      throw AppError.badRequest('VALIDATION_FAILED', 'Cannot start a direct chat with yourself');
    }
    await this.requireUsers([peerId]);
    const directKey = [userId, peerId].sort().join(':');

    const created = await this.prisma.$transaction(async (tx) => {
      // ON CONFLICT makes two simultaneous "open chat" taps converge on one row.
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO conversations (id, type, direct_key)
        VALUES (${uuidv7()}::uuid, 'direct', ${directKey})
        ON CONFLICT (direct_key) DO NOTHING
        RETURNING id`;
      if (inserted.length === 0) return false;
      await tx.conversationMember.createMany({
        data: [
          { conversationId: inserted[0].id, userId, role: 'member' },
          { conversationId: inserted[0].id, userId: peerId, role: 'member' },
        ],
      });
      return true;
    });

    const conv = await this.prisma.conversation.findUniqueOrThrow({
      where: { directKey },
      include: withMembers,
    });
    const dto = toConversationDto(conv);
    if (created) this.realtime.conversationUpdated([peerId], dto);
    return { conversation: dto, created };
  }

  async createGroup(userId: string, memberIds: string[]): Promise<ConversationPayload> {
    if (memberIds.includes(userId)) {
      throw AppError.badRequest('VALIDATION_FAILED', 'memberIds must not include yourself');
    }
    if (memberIds.length + 1 > MAX_GROUP_MEMBERS) throw tooLarge();
    await this.requireUsers(memberIds);
    const conv = await this.prisma.conversation.create({
      data: {
        id: uuidv7(),
        type: 'group',
        members: {
          create: [
            { userId, role: 'admin' },
            ...memberIds.map((m) => ({ userId: m, role: 'member' as const })),
          ],
        },
      },
      include: withMembers,
    });
    const dto = toConversationDto(conv);
    this.realtime.conversationUpdated(memberIds, dto);
    return dto;
  }

  /** Group admins only. Users who are already members are skipped. */
  async addMembers(conversationId: string, callerId: string, userIds: string[]) {
    await this.requireUsers(userIds);
    const conv = await this.prisma.$transaction(async (tx) => {
      const { type, members } = await this.lockMembers(tx, conversationId, callerId);
      if (type !== 'group') throw fixedMembers();
      if (members.find((m) => m.userId === callerId)?.role !== 'admin') {
        throw AppError.forbidden('FORBIDDEN', 'Only group admins can add members');
      }
      const current = new Set(members.map((m) => m.userId));
      const toAdd = userIds.filter((u) => !current.has(u));
      if (current.size + toAdd.length > MAX_GROUP_MEMBERS) throw tooLarge();
      if (toAdd.length > 0) {
        await tx.conversationMember.createMany({
          data: toAdd.map((u) => ({ conversationId, userId: u, role: 'member' as const })),
        });
      }
      return tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: withMembers });
    });
    const dto = toConversationDto(conv);
    this.realtime.conversationUpdated(
      dto.members.map((m) => m.userId),
      dto,
    );
    return dto;
  }

  /** Admins remove anyone; members may only remove themselves (leave). */
  async removeMember(conversationId: string, callerId: string, targetId: string) {
    const remaining = await this.prisma.$transaction(async (tx) => {
      const { type, members } = await this.lockMembers(tx, conversationId, callerId);
      if (type !== 'group') throw fixedMembers();
      const caller = members.find((m) => m.userId === callerId);
      if (targetId !== callerId && caller?.role !== 'admin') {
        throw AppError.forbidden('FORBIDDEN', 'Only group admins can remove other members');
      }
      if (!members.some((m) => m.userId === targetId)) {
        throw AppError.notFound('NOT_A_MEMBER', 'That user is not in this conversation');
      }
      await tx.conversationMember.delete({
        where: { conversationId_userId: { conversationId, userId: targetId } },
      });
      const rest = members.filter((m) => m.userId !== targetId);
      if (rest.length === 0) {
        await tx.conversation.delete({ where: { id: conversationId } });
        return null;
      }
      if (!rest.some((m) => m.role === 'admin')) {
        // `members` is ordered by joinedAt, so rest[0] is the longest-standing member.
        await tx.conversationMember.update({
          where: { conversationId_userId: { conversationId, userId: rest[0].userId } },
          data: { role: 'admin' },
        });
      }
      return tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: withMembers });
    });

    this.realtime.conversationUpdated([targetId], { id: conversationId, removed: true });
    if (remaining) {
      const dto = toConversationDto(remaining);
      this.realtime.conversationUpdated(
        dto.members.map((m) => m.userId),
        dto,
      );
    }
  }

  /** Member user ids, or null when the conversation does not exist. */
  async memberIds(conversationId: string): Promise<string[] | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { members: { select: { userId: true } } },
    });
    return conv ? conv.members.map((m) => m.userId) : null;
  }

  /** Serialises membership changes on one conversation and checks the caller is a member. */
  private async lockMembers(tx: Tx, conversationId: string, callerId: string) {
    const locked = await tx.$queryRaw<{ type: 'direct' | 'group' }[]>`
      SELECT type::text AS type FROM conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notFound();
    const members = await tx.conversationMember.findMany({
      where: { conversationId },
      orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    });
    if (!members.some((m) => m.userId === callerId)) throw notFound();
    return { type: locked[0].type, members };
  }

  private async requireUsers(ids: string[]) {
    const found = await this.prisma.user.count({ where: { id: { in: ids } } });
    if (found !== new Set(ids).size) throw AppError.notFound('USER_NOT_FOUND', 'User not found');
  }
}
