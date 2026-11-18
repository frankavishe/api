import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  type OnGatewayConnection,
  type OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { type AccessClaims, TokenService } from '../auth/token.service.js';
import { DeviceStatusService } from '../devices/device-status.service.js';

export const userRoom = (userId: string) => `user:${userId}`;
export const deviceRoom = (deviceId: string) => `device:${deviceId}`;

interface SocketData {
  auth: AccessClaims;
  expiryTimer?: NodeJS.Timeout;
}

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
}
