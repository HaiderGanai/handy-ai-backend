import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MoreThan } from 'typeorm';
import { Booking } from '../booking/entities/booking.entity';
import { BookingStatus } from '../booking/enums/booking-status.enum';
import { NotificationsService } from '../notifications/notifications.service';
import { Role } from '../user/enums/role.enum';
import { SendMessageDto } from './dto/send-message.dto';
import { Message } from './entities/message.entity';
import { MessagingService } from './messaging.service';

describe('MessagingService', () => {
  let service: MessagingService;
  const bookingRepo = { findOne: jest.fn() };
  const messageRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((v: object) => v),
    save: jest.fn((v: object) =>
      Promise.resolve({ id: 'm1', createdAt: new Date('2030-01-01'), ...v }),
    ),
  };
  const notifications = { notify: jest.fn() };

  const booking = (status: BookingStatus) => ({
    id: 'b1',
    userId: 'customer1',
    status,
    provider: { userId: 'provider1' },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: getRepositoryToken(Booking), useValue: bookingRepo },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  describe('sendMessage', () => {
    it('saves the message and returns only the public view for a customer', async () => {
      bookingRepo.findOne.mockResolvedValue(booking(BookingStatus.CONFIRMED));
      const result = await service.sendMessage(
        'customer1',
        Role.CUSTOMER,
        'b1',
        { body: 'hello' },
      );
      expect(Object.keys(result).sort()).toEqual(
        ['body', 'bookingId', 'createdAt', 'id', 'sender', 'senderId'].sort(),
      );
      expect(result.sender).toBe('CUSTOMER');
      expect(messageRepo.create).toHaveBeenCalledWith({
        bookingId: 'b1',
        senderId: 'customer1',
        body: 'hello',
      });
    });

    it('marks a provider message PROVIDER and notifies the customer', async () => {
      bookingRepo.findOne.mockResolvedValue(booking(BookingStatus.IN_PROGRESS));
      const result = await service.sendMessage(
        'provider1',
        Role.PROVIDER,
        'b1',
        { body: 'on my way' },
      );
      expect(result.sender).toBe('PROVIDER');
      expect(notifications.notify).toHaveBeenCalledWith(
        'customer1',
        'MESSAGE_RECEIVED',
        { bookingId: 'b1' },
      );
    });

    it('notifies the provider when the customer sends', async () => {
      bookingRepo.findOne.mockResolvedValue(
        booking(BookingStatus.PENDING_PROVIDER),
      );
      await service.sendMessage('customer1', Role.CUSTOMER, 'b1', {
        body: 'hi',
      });
      expect(notifications.notify).toHaveBeenCalledWith(
        'provider1',
        'MESSAGE_RECEIVED',
        { bookingId: 'b1' },
      );
    });

    it.each([
      ['a stranger', 'other', Role.CUSTOMER],
      ['another provider', 'other', Role.PROVIDER],
      ['an admin', 'admin1', Role.ADMIN],
    ])('404s for %s', async (_name, userId, role) => {
      bookingRepo.findOne.mockResolvedValue(booking(BookingStatus.CONFIRMED));
      await expect(
        service.sendMessage(userId, role, 'b1', { body: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s when the booking does not exist', async () => {
      bookingRepo.findOne.mockResolvedValue(null);
      await expect(
        service.sendMessage('customer1', Role.CUSTOMER, 'b1', { body: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s for the provider while the booking is unpaid', async () => {
      bookingRepo.findOne.mockResolvedValue(
        booking(BookingStatus.PENDING_PAYMENT),
      );
      await expect(
        service.sendMessage('provider1', Role.PROVIDER, 'b1', { body: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it.each([
      BookingStatus.PENDING_PAYMENT,
      BookingStatus.DECLINED,
      BookingStatus.CANCELLED,
      BookingStatus.COMPLETED,
    ])('409s when the booking is %s', async (status) => {
      bookingRepo.findOne.mockResolvedValue(booking(status));
      await expect(
        service.sendMessage('customer1', Role.CUSTOMER, 'b1', { body: 'x' }),
      ).rejects.toThrow(ConflictException);
      expect(messageRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('SendMessageDto', () => {
    const check = (body: unknown) =>
      validate(plainToInstance(SendMessageDto, { body }));

    it('rejects a whitespace-only body', async () => {
      expect(await check('   ')).not.toHaveLength(0);
    });
    it('rejects a body over 1000 characters', async () => {
      expect(await check('a'.repeat(1001))).not.toHaveLength(0);
    });
    it('accepts and trims a normal body', async () => {
      const dto = plainToInstance(SendMessageDto, { body: '  hi  ' });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.body).toBe('hi');
    });
  });

  describe('listMessages', () => {
    const row = (id: string, at: string) => ({
      id,
      bookingId: 'b1',
      senderId: 'customer1',
      body: id,
      createdAt: new Date(at),
    });

    it('reads in any booking status, including COMPLETED', async () => {
      bookingRepo.findOne.mockResolvedValue(booking(BookingStatus.COMPLETED));
      messageRepo.find.mockResolvedValue([]);
      await expect(
        service.listMessages('customer1', Role.CUSTOMER, 'b1', {}),
      ).resolves.toEqual({ messages: [] });
    });

    it('without after returns the latest limit messages, oldest first', async () => {
      bookingRepo.findOne.mockResolvedValue(booking(BookingStatus.CONFIRMED));
      messageRepo.find.mockResolvedValue([
        row('m2', '2030-01-02'),
        row('m1', '2030-01-01'),
      ]);
      const result = await service.listMessages(
        'customer1',
        Role.CUSTOMER,
        'b1',
        { limit: 2 },
      );
      expect(messageRepo.find).toHaveBeenCalledWith({
        where: { bookingId: 'b1' },
        order: { createdAt: 'DESC' },
        take: 2,
      });
      expect(result.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    });

    it('defaults to 50 messages', async () => {
      bookingRepo.findOne.mockResolvedValue(booking(BookingStatus.CONFIRMED));
      messageRepo.find.mockResolvedValue([]);
      await service.listMessages('customer1', Role.CUSTOMER, 'b1', {});
      expect(messageRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });

    it('with after returns only newer messages, oldest first', async () => {
      bookingRepo.findOne.mockResolvedValue(booking(BookingStatus.CONFIRMED));
      const cursor = row('m1', '2030-01-01');
      messageRepo.findOne.mockResolvedValue(cursor);
      messageRepo.find.mockResolvedValue([row('m2', '2030-01-02')]);
      const result = await service.listMessages(
        'customer1',
        Role.CUSTOMER,
        'b1',
        { after: 'm1' },
      );
      expect(messageRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'm1', bookingId: 'b1' },
      });
      expect(messageRepo.find).toHaveBeenCalledWith({
        where: { bookingId: 'b1', createdAt: MoreThan(cursor.createdAt) },
        order: { createdAt: 'ASC' },
        take: 50,
      });
      expect(result.messages.map((m) => m.id)).toEqual(['m2']);
    });

    it('400s when after is not a message of this booking', async () => {
      bookingRepo.findOne.mockResolvedValue(booking(BookingStatus.CONFIRMED));
      messageRepo.findOne.mockResolvedValue(null);
      await expect(
        service.listMessages('customer1', Role.CUSTOMER, 'b1', {
          after: 'other-booking-message',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s for a non-participant', async () => {
      bookingRepo.findOne.mockResolvedValue(booking(BookingStatus.CONFIRMED));
      await expect(
        service.listMessages('other', Role.CUSTOMER, 'b1', {}),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
