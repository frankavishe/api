import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller.js';
import { CleanupService } from './auth/cleanup.service.js';
import { OtpService } from './auth/otp.service.js';
import { SessionService } from './auth/session.service.js';
import { LogSmsSender, SmsSender } from './auth/sms/sms-sender.js';
import { ContactsController, ContactsService } from './contacts/contacts.controller.js';
import { DevicesController } from './devices/devices.controller.js';
import { DevicesService } from './devices/devices.service.js';
import { AvatarsController, MeController } from './users/me.controller.js';
import { UserPresenter } from './users/user.presenter.js';
import { UsersService } from './users/users.service.js';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}

@Module({
  controllers: [MeController, AvatarsController],
  providers: [UserPresenter, UsersService],
  exports: [UserPresenter, UsersService],
})
export class UsersModule {}

@Module({
  imports: [DevicesModule, UsersModule],
  controllers: [AuthController],
  providers: [
    OtpService,
    SessionService,
    CleanupService,
    { provide: SmsSender, useClass: LogSmsSender },
  ],
})
export class AuthModule {}

@Module({
  imports: [UsersModule],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
