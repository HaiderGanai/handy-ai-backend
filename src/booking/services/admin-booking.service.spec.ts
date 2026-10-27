import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsService } from '../../notifications/notifications.service';
import { Booking } from '../entities/booking.entity';
import { BookingStatus } from '../enums/booking-status.enum';
import { AdminBookingService } from './admin-booking.service';
import { BookingPlanService } from './booking-plan.service';

describe('AdminBookingService', () => {
  let service: AdminBookingService;
  const bookingRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn((v: object) => Promise.resolve(v)),
  };
  const planService = { getPostcode: jest.fn(), assertEligible: jest.fn() };
  const notifications = { notify: jest.fn() };

  const makeBooking = (status: BookingStatus) => ({
    id: 'b1',
    userId: 'c1',
    providerId: 'p1',
    scheduledAt: new Date('2999-01-01T10:00:00Z'),
    durationMinutes: 60,
    status,
    subService: { categoryId: 'cat1' },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    planService.getPostcode.mockResolvedValue('SW1A 1AA');
    planService.assertEligible.mockResolvedValue({ id: 'p2', userId: 'pu2' });
    const module = await Test.createTestingModule({
      providers: [
        AdminBookingService,
        { provide: getRepositoryToken(Booking), useValue: bookingRepo },
        { provide: BookingPlanService, useValue: planService },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(AdminBookingService);
  });

  it('reassigns a confirmed booking and sends it back to the new provider for acceptance', async () => {
    bookingRepo.findOne.mockResolvedValue(makeBooking(BookingStatus.CONFIRMED));
    const booking = await service.reassignBooking('b1', { providerId: 'p2' });
    expect(booking.providerId).toBe('p2');
    expect(booking.status).toBe(BookingStatus.PENDING_PROVIDER);
    expect(planService.assertEligible).toHaveBeenCalledWith(
      'p2',
      expect.objectContaining({ excludeBookingId: 'b1' }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      'pu2',
      'BOOKING_REQUESTED',
      expect.any(Object),
    );
  });

  it('refuses to reassign an in-progress booking', async () => {
    bookingRepo.findOne.mockResolvedValue(
      makeBooking(BookingStatus.IN_PROGRESS),
    );
    await expect(
      service.reassignBooking('b1', { providerId: 'p2' }),
    ).rejects.toThrow(ConflictException);
  });

  it('404s an unknown booking', async () => {
    bookingRepo.findOne.mockResolvedValue(null);
    await expect(
      service.reassignBooking('b1', { providerId: 'p2' }),
    ).rejects.toThrow(NotFoundException);
  });
});
