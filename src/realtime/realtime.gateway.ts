import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { type AccessClaims, TokenService } from '../auth/token.service.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import { DeviceStatusService } from '../devices/device-status.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const userRoom = (userId: string) => `user:${userId}`;
export const deviceRoom = (deviceId: string) => `device:${deviceId}`;

interface SocketData {
  auth: AccessClaims;
  expiryTimer?: NodeJS.Timeout;
}

const typingSchema = z.strictObject({
  conversationId: z.uuid(),
  state: z.enum(['start', 'stop']),
});

function connectError(code: 'UNAUTHORIZED' | 'SESSION_REVOKED', message: string) {
  const err = new Error(message) as Error & { data: { code: string } };
  err.data = { code };
  return err;
}

/**
 * Socket.IO namespace /rt — see contracts/ws-events.schema.json.
 * Auth runs in middleware because an async handleConnection is not awaited before messages.
 */
@WebSocketGateway({ namespace: '/rt' })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() server!: Namespace;
  private readonly logger = new Logger('Realtime');

  constructor(
    private readonly tokens: TokenService,
    private readonly jwt: JwtService,
    private readonly devices: DeviceStatusService,
    private readonly prisma: PrismaService,
    private readonly limits: RateLimitService,
  ) {}

  afterInit(server: Namespace) {
    server.use(async (socket, next) => {
      const token: unknown = socket.handshake.auth?.token;
      if (typeof token !== 'string') return next(connectError('UNAUTHORIZED', 'Missing token'));
      try {
        const auth = await this.tokens.verifyAccess(token);
        if (!(await this.devices.isActive(auth.deviceId))) {
          return next(connectError('SESSION_REVOKED', 'This device has been signed out'));
        }
        const data = socket.data as SocketData;
        data.auth = auth;
        const exp = (this.jwt.decode(token) as { exp?: number } | null)?.exp;
        if (exp) {
          // Ask the client to refresh just before the token stops being valid.
          const ms = Math.max(exp * 1000 - Date.now(), 0);
          data.expiryTimer = setTimeout(() => {
            socket.emit('auth:expired', {});
            socket.disconnect(true);
          }, ms);
          socket.on('disconnect', () => clearTimeout(data.expiryTimer));
        }
        next();
      } catch {
        next(connectError('UNAUTHORIZED', 'Access token is invalid or expired'));
      }
    });
  }

  async handleConnection(socket: Socket) {
    const { auth } = socket.data as SocketData;
    await socket.join([userRoom(auth.userId), deviceRoom(auth.deviceId)]);
    this.logger.debug(`connected device ${auth.deviceId}`);
  }

  /**
   * Ephemeral typing relay (feature 002): never stored, never acknowledged.
   * Bad payloads, non-members, revoked devices and floods are dropped silently.
   */
  @SubscribeMessage('typing')
  async onTyping(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<void> {
    const parsed = typingSchema.safeParse(body);
    if (!parsed.success) return;
    const { auth } = socket.data as SocketData;
    try {
      if (!(await this.devices.isActive(auth.deviceId))) return;
      const limit = await this.limits.hit(`typing:${auth.deviceId}`, 20, 10);
      if (!limit.allowed) return;
      const members = await this.prisma.conversationMember.findMany({
        where: { conversationId: parsed.data.conversationId },
        select: { userId: true },
      });
      if (!members.some((m) => m.userId === auth.userId)) return;
      const others = members.filter((m) => m.userId !== auth.userId).map((m) => userRoom(m.userId));
      if (others.length === 0) return;
      this.server.to(others).emit('typing', { ...parsed.data, userId: auth.userId });
    } catch (err) {
      this.logger.warn(`typing relay failed: ${(err as Error).message}`);
    }
  }
}
