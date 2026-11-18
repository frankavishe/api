import { Controller, Delete, Get, HttpCode, Param } from '@nestjs/common';
import { z } from 'zod';
import type { AccessClaims } from '../auth/token.service.js';
import { CurrentAuth } from '../common/auth.guard.js';
import { DevicesService, toDeviceDto } from './devices.service.js';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  async list(@CurrentAuth() auth: AccessClaims) {
    const devices = await this.devices.list(auth.userId);
    return devices.map((d) => toDeviceDto(d, auth.deviceId));
  }

  @Delete(':deviceId')
  @HttpCode(204)
  async revoke(
    @CurrentAuth() auth: AccessClaims,
    @Param('deviceId', { schema: z.uuid() }) deviceId: string,
  ) {
    await this.devices.revokeOwn(auth.userId, deviceId);
  }
}
