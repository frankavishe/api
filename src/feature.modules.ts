import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller.js';
import { CleanupService } from './auth/cleanup.service.js';
import { OtpService } from './auth/otp.service.js';
import { SessionService } from './auth/session.service.js';
import { LogSmsSender, SmsSender } from './auth/sms/sms-sender.js';
import { ContactsController, ContactsService } from './contacts/contacts.controller.js';
import { ConversationsController } from './conversations/conversations.controller.js';
import { ConversationsService } from './conversations/conversations.service.js';
import { DevicesController } from './devices/devices.controller.js';
import { DevicesService } from './devices/devices.service.js';
import { KeysController } from './keys/keys.controller.js';
import { KeysService } from './keys/keys.service.js';
import { MessagesController } from './messages/messages.controller.js';
import { MessagesService } from './messages/messages.service.js';
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

// Feature 002: end-to-end encrypted messaging. The server never runs crypto.

@Module({
  controllers: [KeysController],
  providers: [KeysService],
})
export class KeysModule {}

@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}

@Module({
  imports: [ConversationsModule],
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
