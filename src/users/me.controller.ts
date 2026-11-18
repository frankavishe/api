import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Put,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import type { AccessClaims } from '../auth/token.service.js';
import { CurrentAuth, Public } from '../common/auth.guard.js';
import { AppError } from '../common/errors.js';
import type { Env } from '../config/env.js';
import { StorageService } from '../storage/storage.service.js';
import { UserPresenter } from './user.presenter.js';
import { MAX_AVATAR_BYTES, UsersService } from './users.service.js';

const updateProfileSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(25).optional(),
    about: z.string().trim().max(140).optional(),
  })
  .refine((v) => v.displayName !== undefined || v.about !== undefined, {
    message: 'Provide displayName or about',
  });

@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly presenter: UserPresenter,
  ) {}

  @Get()
  async me(@CurrentAuth() auth: AccessClaims) {
    return this.presenter.toMe(await this.users.get(auth.userId));
  }

  @Patch()
  async update(
    @CurrentAuth() auth: AccessClaims,
    @Body({ schema: updateProfileSchema }) body: z.infer<typeof updateProfileSchema>,
  ) {
    return this.presenter.toMe(await this.users.update(auth.userId, body));
  }

  @Put('avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } }))
  async uploadAvatar(@CurrentAuth() auth: AccessClaims, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw AppError.badRequest('VALIDATION_FAILED', 'Attach the image as "file"');
    return this.presenter.toMe(await this.users.setAvatar(auth.userId, file.buffer));
  }

  @Delete('avatar')
  async deleteAvatar(@CurrentAuth() auth: AccessClaims) {
    return this.presenter.toMe(await this.users.deleteAvatar(auth.userId));
  }
}

const avatarKeySchema = z.string().regex(/^[0-9a-f-]{36}(_thumb)?\.webp$/);

/** Public, immutable avatar images (a new key is used on every change). */
@Controller('avatars')
export class AvatarsController {
  private readonly bucket: string;

  constructor(
    private readonly storage: StorageService,
    config: ConfigService<Env, true>,
  ) {
    this.bucket = config.get('S3_BUCKET_AVATARS', { infer: true });
  }

  @Public()
  @Get(':key')
  async get(@Param('key') key: string, @Res() res: Response) {
    const notFound = AppError.notFound('USER_NOT_FOUND', 'Avatar not found');
    if (!avatarKeySchema.safeParse(key).success) throw notFound;
    const obj = await this.storage.get(this.bucket, key);
    if (!obj) throw notFound;
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    obj.body.pipe(res);
  }
}
