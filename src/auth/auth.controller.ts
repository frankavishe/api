import { Body, Controller, HttpCode, Ip, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import type { AccessClaims } from './token.service.js';
import { CurrentAuth, Public } from '../common/auth.guard.js';
import { AppError } from '../common/errors.js';
import { E164_PATTERN, normalizePhone } from '../common/phone.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import { DevicesService, toDeviceDto } from '../devices/devices.service.js';
import type { Device } from '../generated/prisma/client.js';
import { UserPresenter } from '../users/user.presenter.js';
import { OtpService } from './otp.service.js';
import { REFRESH_TTL_MS, SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

const phoneSchema = z.string().regex(E164_PATTERN, 'Phone must be in international format');
const requestCodeSchema = z.strictObject({ phone: phoneSchema });
const verifySchema = z.strictObject({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/),
  deviceType: z.enum(['android', 'web']),
  deviceName: z.string().trim().min(1).max(64),
});
const refreshSchema = z.strictObject({ refreshToken: z.string().min(1).optional() }).optional();

const REFRESH_COOKIE = 'rt';

function validPhone(raw: string): string {
  const phone = normalizePhone(raw);
  if (!phone) throw AppError.badRequest('INVALID_PHONE', 'This phone number is not valid');
  return phone;
}

@Controller('auth')
export class AuthController {
  private readonly cookieOptions: CookieOptions;

  constructor(
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly devices: DevicesService,
    private readonly tokens: TokenService,
    private readonly limits: RateLimitService,
    private readonly users: UserPresenter,
  ) {
    // Secure cookies are accepted on http://localhost by modern browsers.
    this.cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/v1/auth' };
  }

  @Public()
  @Post('request-code')
  @HttpCode(202)
  async requestCode(@Body({ schema: requestCodeSchema }) body: z.infer<typeof requestCodeSchema>, @Ip() ip: string) {
    return this.otp.request(validPhone(body.phone), ip);
  }

  @Public()
  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body({ schema: verifySchema }) body: z.infer<typeof verifySchema>,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.limits.consume(`verify:ip:${ip}`, 10, 600);
    const phone = validPhone(body.phone);
    await this.otp.verify(phone, body.code);

    const reg =
      body.deviceType === 'android'
        ? await this.devices.registerAndroid(phone, body.deviceName)
        : await this.devices.registerWeb(phone, body.deviceName);
    const { refreshToken } = await this.sessions.create(reg.device.id);
    const tokens = await this.issue(reg.device, refreshToken, res);

    return {
      ...tokens,
      isNewAccount: reg.isNewAccount,
      device: toDeviceDto(reg.device, reg.device.id),
      user: this.users.toMe(reg.user),
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body({ schema: refreshSchema }) body: z.infer<typeof refreshSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const presented = body?.refreshToken ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined);
    if (!presented) throw AppError.unauthorized('SESSION_REVOKED', 'No refresh token');
    try {
      const { device, refreshToken } = await this.sessions.rotate(presented);
      return await this.issue(device, refreshToken, res);
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, this.cookieOptions);
      throw err;
    }
  }

  @Post('sign-out')
  @HttpCode(204)
  async signOut(@CurrentAuth() auth: AccessClaims, @Res({ passthrough: true }) res: Response) {
    await this.devices.revoke(auth.deviceId, 'signed_out');
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions);
  }

  /** Android gets the refresh token in the body; web gets it only as an HttpOnly cookie. */
  private async issue(device: Device, refreshToken: string, res: Response) {
    const { accessToken, expiresIn } = await this.tokens.signAccess({
      userId: device.userId,
      deviceId: device.id,
      deviceType: device.type,
    });
    if (device.type === 'web') {
      res.cookie(REFRESH_COOKIE, refreshToken, { ...this.cookieOptions, maxAge: REFRESH_TTL_MS });
      return { accessToken, expiresIn };
    }
    return { accessToken, expiresIn, refreshToken };
  }
}
