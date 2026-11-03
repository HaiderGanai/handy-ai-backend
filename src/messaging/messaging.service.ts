import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { Booking } from '../booking/entities/booking.entity';
import { BookingStatus } from '../booking/enums/booking-status.enum';
import { NotificationsService } from '../notifications/notifications.service';
import { Role } from '../user/enums/role.enum';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { Message } from './entities/message.entity';

export interface MessageView {
  id: string;
  bookingId: string;
  senderId: string;
  sender: 'CUSTOMER' | 'PROVIDER';
  body: string;
  createdAt: Date;
}

// messages can be written only while the job is live
const MESSAGING_OPEN_STATUSES = [
  BookingStatus.PENDING_PROVIDER,
  BookingStatus.CONFIRMED,
  BookingStatus.IN_PROGRESS,
];

@Injectable()
export class MessagingService {
  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    private readonly notificationsService: NotificationsService,
  ) {}

  async sendMessage(
    userId: string,
    role: Role,
    bookingId: string,
    data: SendMessageDto,
  ): Promise<MessageView> {
    //only the booking's two parties get to see it exists
    const booking = await this.getParticipantBooking(userId, role, bookingId);
    if (!MESSAGING_OPEN_STATUSES.includes(booking.status)) {
      throw new ConflictException('Messaging is closed for this booking!');
    }

    //save the message
    const message = await this.messageRepository.save(
      this.messageRepository.create({
        bookingId,
        senderId: userId,
        body: data.body,
      }),
    );

    //tell the other party (never the text itself)
    const otherUserId =
      userId === booking.userId ? booking.provider.userId : booking.userId;
    this.notificationsService.notify(otherUserId, 'MESSAGE_RECEIVED', {
      bookingId,
    });
    return this.toView(message, booking);
  }

  async listMessages(
    userId: string,
    role: Role,
    bookingId: string,
    query: ListMessagesQueryDto,
  ): Promise<{ messages: MessageView[] }> {
    const booking = await this.getParticipantBooking(userId, role, bookingId);
    const take = query.limit ?? 50;

    //no cursor: the latest page, flipped to oldest first
    if (!query.after) {
      const latest = await this.messageRepository.find({
        where: { bookingId },
        order: { createdAt: 'DESC' },
        take,
      });
      return {
        messages: latest.reverse().map((m) => this.toView(m, booking)),
      };
    }

    //cursor: must be a message of this booking, so ids from other threads can't be probed
    const cursor = await this.messageRepository.findOne({
      where: { id: query.after, bookingId },
    });
    if (!cursor) {
      throw new BadRequestException('Unknown message cursor!');
    }
    // ponytail: cursor is createdAt (microseconds); two messages in the same microsecond could be skipped, add a sequence column if it ever shows up
    const newer = await this.messageRepository.find({
      where: { bookingId, createdAt: MoreThan(cursor.createdAt) },
      order: { createdAt: 'ASC' },
      take,
    });
    return { messages: newer.map((m) => this.toView(m, booking)) };
  }

  private async getParticipantBooking(
    userId: string,
    role: Role,
    bookingId: string,
  ): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: { provider: true },
    });
    const isCustomer = role === Role.CUSTOMER && booking?.userId === userId;
    const isProvider =
      role === Role.PROVIDER &&
      booking?.provider.userId === userId &&
      booking.status !== BookingStatus.PENDING_PAYMENT;
    if (!booking || !(isCustomer || isProvider)) {
      throw new NotFoundException('Booking not found!');
    }
    return booking;
  }

  private toView(message: Message, booking: Booking): MessageView {
    return {
      id: message.id,
      bookingId: message.bookingId,
      senderId: message.senderId,
      sender: message.senderId === booking.userId ? 'CUSTOMER' : 'PROVIDER',
      body: message.body,
      createdAt: message.createdAt,
    };
  }
}
