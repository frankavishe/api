import { Body, Controller, Get, HttpCode, Injectable, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { AccessClaims } from '../auth/token.service.js';
import { CurrentAuth } from '../common/auth.guard.js';
import { AppError } from '../common/errors.js';
import { E164_PATTERN } from '../common/phone.js';
import { RateLimitService } from '../common/rate-limit.service.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UserPresenter } from '../users/user.presenter.js';

const phone = z.string().regex(E164_PATTERN, 'Phone must be in international format');
const discoverSchema = z.strictObject({ phones: z.array(phone).min(1).max(1000) });
const lookupSchema = z.object({ phone });

const byName = [{ displayName: { sort: 'asc', nulls: 'last' } }, { phoneE164: 'asc' }] as const;

/** Contact discovery (FR-013..FR-015). Numbers without an account are never stored. */
@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async discover(ownerId: string, phones: string[]): Promise<User[]> {
    const matches = await this.prisma.user.findMany({
      where: { phoneE164: { in: [...new Set(phones)] }, id: { not: ownerId } },
      orderBy: [...byName],
    });
    if (matches.length > 0) {
      await this.prisma.contact.createMany({
        data: matches.map((m) => ({ ownerId, contactUserId: m.id })),
        skipDuplicates: true,
      });
    }
    return matches;
  }

  list(ownerId: string): Promise<User[]> {
    return this.prisma.user.findMany({
      where: { contactOf: { some: { ownerId } } },
      orderBy: [...byName],
    });
  }

  findByPhone(phoneE164: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phoneE164 } });
  }
}

@Controller()
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly limits: RateLimitService,
    private readonly presenter: UserPresenter,
  ) {}

  @Post('contacts/discover')
  @HttpCode(200)
  async discover(
    @CurrentAuth() auth: AccessClaims,
    @Body({ schema: discoverSchema }) body: z.infer<typeof discoverSchema>,
  ) {
    await this.limits.consume(`discover:${auth.deviceId}`, 10, 3600);
    const users = await this.contacts.discover(auth.userId, body.phones);
    return users.map((u) => this.presenter.toPublic(u));
  }

  @Get('contacts')
  async list(@CurrentAuth() auth: AccessClaims) {
    const users = await this.contacts.list(auth.userId);
    return users.map((u) => this.presenter.toPublic(u));
  }

  @Get('users/lookup')
  async lookup(
    @CurrentAuth() auth: AccessClaims,
    @Query({ schema: lookupSchema }) query: z.infer<typeof lookupSchema>,
  ) {
    await this.limits.consume(`lookup:${auth.deviceId}`, 60, 3600);
    const user = await this.contacts.findByPhone(query.phone);
    if (!user) throw AppError.notFound('USER_NOT_FOUND', 'This number is not on Chat App');
    return this.presenter.toPublic(user);
  }
}
