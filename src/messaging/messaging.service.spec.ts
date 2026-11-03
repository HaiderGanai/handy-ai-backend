import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
});
