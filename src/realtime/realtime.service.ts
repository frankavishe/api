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
}
