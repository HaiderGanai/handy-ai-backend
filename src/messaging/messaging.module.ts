import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../booking/entities/booking.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Message } from './entities/message.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Message, Booking]), NotificationsModule],
})
export class MessagingModule {}
