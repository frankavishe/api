import { Injectable } from '@nestjs/common';
import { deviceRoom, RealtimeGateway, userRoom } from './realtime.gateway.js';

export type RevokedReason = 'signed_out' | 'replaced' | 'evicted' | 'token_reuse' | 'inactive';

export interface ProfilePayload {
  id: string;
  displayName: string | null;
  about: string;
  avatarUrl: string | null;
  avatarThumbUrl: string | null;
}

export interface EnvelopePayload {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  type: 'prekey' | 'whisper';
  ciphertext: string;
  serverTimestamp: string;
}

export interface ConversationPayload {
  id: string;
  type: 'direct' | 'group';
  createdAt: string;
  members: { userId: string; role: 'admin' | 'member'; joinedAt: string }[];
}

export interface TypingPayload {
  conversationId: string;
  userId: string;
  state: 'start' | 'stop';
}

/** Typed server→client events from contracts/ws-events.schema.json. */
@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  /** Tells the device it was signed out, then drops its sockets. */
  deviceRevoked(deviceId: string, reason: RevokedReason) {
    const room = this.gateway.server.to(deviceRoom(deviceId));
    room.emit('device:revoked', { deviceId, reason });
    this.gateway.server.in(deviceRoom(deviceId)).disconnectSockets(false);
  }

  profileUpdated(userIds: string[], payload: ProfilePayload) {
    if (userIds.length === 0) return;
    this.gateway.server.to(userIds.map(userRoom)).emit('profile:updated', payload);
  }

  /** One stored envelope for one device (feature 002). */
  envelopeNew(deviceId: string, payload: EnvelopePayload) {
    this.gateway.server.to(deviceRoom(deviceId)).emit('envelope:new', payload);
  }

  /** Conversation created or membership changed; removed users get `{ id, removed: true }`. */
  conversationUpdated(userIds: string[], payload: ConversationPayload | { id: string; removed: true }) {
    if (userIds.length === 0) return;
    this.gateway.server.to(userIds.map(userRoom)).emit('conversation:updated', payload);
  }

  /** Ephemeral typing relay; never stored. */
  typing(userIds: string[], payload: TypingPayload) {
    if (userIds.length === 0) return;
    this.gateway.server.to(userIds.map(userRoom)).emit('typing', payload);
  }

  /** The device is running out of one-time prekeys and should upload more. */
  prekeysLow(deviceId: string, count: number) {
    this.gateway.server.to(deviceRoom(deviceId)).emit('prekeys:low', { count });
  }
}
