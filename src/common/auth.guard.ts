import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type AccessClaims, TokenService } from '../auth/token.service.js';
import { DeviceStatusService } from '../devices/device-status.service.js';
import { AppError } from './errors.js';

const IS_PUBLIC = 'isPublic';
/** Marks a route as not needing an access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

type AuthedRequest = Request & { auth?: AccessClaims };

/** The signed-in user/device for this request. */
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
});

/** Global guard: valid access token AND device not revoked. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly devices: DeviceStatusService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw AppError.unauthorized();

    let claims: AccessClaims;
    try {
      claims = await this.tokens.verifyAccess(header.slice(7));
    } catch {
      throw AppError.unauthorized('UNAUTHORIZED', 'Access token is invalid or expired');
    }
    if (!(await this.devices.isActive(claims.deviceId))) {
      throw AppError.unauthorized('SESSION_REVOKED', 'This device has been signed out');
    }
    await this.devices.touch(claims.deviceId);
    req.auth = claims;
    return true;
  }
}
