import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { AccessClaims } from '../auth/token.service.js';
import { fromB64, toB64 } from '../common/base64.js';
import { AppError } from '../common/errors.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import type { Envelope } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type EnvelopePayload, RealtimeService } from '../realtime/realtime.service.js';

export interface OutgoingEnvelope {
  deviceId: string;
  type: 'prekey' | 'whisper';
  ciphertext: string;
}

interface DeviceRef {
  userId: string;
  deviceId: string;
}

export function toEnvelopeDto(e: Envelope): EnvelopePayload {
  return {
    id: e.id,
    conversationId: e.conversationId,
    senderUserId: e.senderUserId,
    senderDeviceId: e.senderDeviceId,
    type: e.type,
    ciphertext: toB64(e.ciphertext),
    serverTimestamp: e.serverTimestamp.toISOString(),
  };
}

/** Stores and relays opaque Signal ciphertext: one envelope per recipient device. */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly realtime: RealtimeService,
  ) {}

  async send(sender: AccessClaims, conversationId: string, envelopes: OutgoingEnvelope[]) {
    const members = await this.conversations.memberIds(conversationId);
    if (!members) throw AppError.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
    if (!members.includes(sender.userId)) {
      throw AppError.forbidden('NOT_A_MEMBER', 'You are not a member of this conversation');
    }

    // Every active, key-holding device of every member, except the sending device itself.
    const expected = await this.prisma.device.findMany({
      where: {
        userId: { in: members },
        revokedAt: null,
        keys: { isNot: null },
        id: { not: sender.deviceId },
      },
      select: { id: true, userId: true },
    });
    const expectedIds = new Set(expected.map((d) => d.id));
    const given = new Set(envelopes.map((e) => e.deviceId));

    const missingDevices: DeviceRef[] = expected
      .filter((d) => !given.has(d.id))
      .map((d) => ({ userId: d.userId, deviceId: d.id }));
    const staleIds = [...given].filter((id) => !expectedIds.has(id));
    if (missingDevices.length > 0 || staleIds.length > 0) {
      const staleDevices = await this.staleRefs(staleIds);
      throw AppError.conflict('DEVICE_MISMATCH', 'Device list is out of date', {
        missingDevices,
        staleDevices,
      });
    }

    const serverTimestamp = new Date();
    const rows = envelopes.map((e) => ({
      id: uuidv7(),
      recipientDeviceId: e.deviceId,
      conversationId,
      senderUserId: sender.userId,
      senderDeviceId: sender.deviceId,
      type: e.type,
      ciphertext: fromB64(e.ciphertext),
      serverTimestamp,
    }));
    if (rows.length > 0) await this.prisma.envelope.createMany({ data: rows });
    for (const row of rows) this.realtime.envelopeNew(row.recipientDeviceId, toEnvelopeDto(row));
    return { serverTimestamp: serverTimestamp.toISOString() };
  }

  /** Oldest first; ids are UUIDv7 so they sort by creation time. */
  async pending(deviceId: string, limit: number): Promise<EnvelopePayload[]> {
    const rows = await this.prisma.envelope.findMany({
      where: { recipientDeviceId: deviceId },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map(toEnvelopeDto);
  }

  /** Unknown ids and ids addressed to other devices are ignored. */
  async ack(deviceId: string, ids: string[]): Promise<void> {
    await this.prisma.envelope.deleteMany({ where: { id: { in: ids }, recipientDeviceId: deviceId } });
  }

  /**
   * Resolves owners of devices that are revoked, keyless or outside the conversation.
   * Device rows are never hard-deleted, so an id that matches no row is a client bug.
   */
  private async staleRefs(ids: string[]): Promise<DeviceRef[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.device.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true },
    });
    if (rows.length !== ids.length) {
      const known = new Set(rows.map((r) => r.id));
      throw AppError.badRequest('VALIDATION_FAILED', 'Envelope addressed to an unknown device', {
        unknownDevices: ids.filter((id) => !known.has(id)),
      });
    }
    return rows.map((r) => ({ userId: r.userId, deviceId: r.id }));
  }
}
