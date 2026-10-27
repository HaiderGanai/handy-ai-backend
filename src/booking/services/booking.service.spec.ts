import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsService } from '../../notifications/notifications.service';
import { Provider } from '../../provider/entities/provider.entity';
import { User } from '../../user/entities/user.entity';
import { Role } from '../../user/enums/role.enum';
import { Booking } from '../entities/booking.entity';
import { TrustedProvider } from '../entities/trusted-provider.entity';
import { BookingStatus } from '../enums/booking-status.enum';
import { BookingPlanService } from './booking-plan.service';
import { BookingService } from './booking.service';

describe('BookingService', () => {
  let service: BookingService;
  const bookingRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    exists: jest.fn(),
    create: jest.fn((v: object) => v),
    save: jest.fn((v: object) => Promise.resolve({ id: 'b1', ...v })),
  };
  const providerRepo = { findOne: jest.fn() };
  const trustedRepo = { upsert: jest.fn() };
  const userRepo = { findOne: jest.fn() };
  const planService = {
    getSubService: jest.fn(),
    getPostcode: jest.fn(),
    assertEligible: jest.fn(),
  };
  const notifications = { notify: jest.fn() };

  const future = new Date('2999-01-01T10:00:00Z');
  const makeBooking = (over: object = {}) => ({
    id: 'b1',
    userId: 'c1',
    providerId: 'p1',
    subServiceId: 's1',
    scheduledAt: future,
    durationMinutes: 60,
    priceCents: 12000,
    status: BookingStatus.PENDING_PROVIDER,
    notes: null,
    provider: { userId: 'pu1' },
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    planService.getSubService.mockResolvedValue({
      id: 's1',
      categoryId: 'cat1',
      basePriceCents: 12000,
      baseDurationMinutes: 60,
    });
    planService.getPostcode.mockResolvedValue('SW1A 1AA');
    planService.assertEligible.mockResolvedValue({ id: 'p1', userId: 'pu1' });
    providerRepo.findOne.mockResolvedValue({ id: 'p1', userId: 'pu1' });
    const module = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: getRepositoryToken(Booking), useValue: bookingRepo },
        { provide: getRepositoryToken(Provider), useValue: providerRepo },
        { provide: getRepositoryToken(TrustedProvider), useValue: trustedRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: BookingPlanService, useValue: planService },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(BookingService);
  });

  describe('createBooking', () => {
    const data = { subServiceId: 's1', scheduledAt: future, providerId: 'p1' };

    it('creates a PENDING_PROVIDER booking priced from the catalog and notifies the provider', async () => {
      const booking = await service.createBooking('c1', data);
      expect(booking.status).toBe(BookingStatus.PENDING_PROVIDER);
      expect(booking.priceCents).toBe(12000);
      expect(booking.durationMinutes).toBe(60);
      expect(notifications.notify).toHaveBeenCalledWith(
        'pu1',
        'BOOKING_REQUESTED',
        expect.any(Object),
      );
    });

    it('does not save when the provider is not eligible', async () => {
      planService.assertEligible.mockRejectedValue(new ConflictException());
      await expect(service.createBooking('c1', data)).rejects.toThrow(
        ConflictException,
      );
      expect(bookingRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('provider transitions', () => {
    it('accepts a pending booking', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      const booking = await service.acceptBooking('pu1', 'b1');
      expect(booking.status).toBe(BookingStatus.CONFIRMED);
    });

    it('runs CONFIRMED -> IN_PROGRESS -> COMPLETED and declines from pending', async () => {
      bookingRepo.findOne.mockResolvedValueOnce(
        makeBooking({ status: BookingStatus.CONFIRMED }),
      );
      expect((await service.startBooking('pu1', 'b1')).status).toBe(
        BookingStatus.IN_PROGRESS,
      );
      bookingRepo.findOne.mockResolvedValueOnce(
        makeBooking({ status: BookingStatus.IN_PROGRESS }),
      );
      expect((await service.completeBooking('pu1', 'b1')).status).toBe(
        BookingStatus.COMPLETED,
      );
      bookingRepo.findOne.mockResolvedValueOnce(makeBooking());
      expect((await service.declineBooking('pu1', 'b1')).status).toBe(
        BookingStatus.DECLINED,
      );
    });

    it('409s an illegal transition', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeBooking({ status: BookingStatus.CONFIRMED }),
      );
      await expect(service.completeBooking('pu1', 'b1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('404s when the booking belongs to another provider', async () => {
      bookingRepo.findOne.mockResolvedValue(null);
      await expect(service.acceptBooking('pu1', 'b1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateBooking', () => {
    it('keeps CONFIRMED when only notes change', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeBooking({ status: BookingStatus.CONFIRMED }),
      );
      const booking = await service.updateBooking('c1', 'b1', {
        notes: 'Gate code 1234',
      });
      expect(booking.status).toBe(BookingStatus.CONFIRMED);
      expect(booking.notes).toBe('Gate code 1234');
      expect(planService.assertEligible).not.toHaveBeenCalled();
    });

    it('re-validates and resets to PENDING_PROVIDER on a time change', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeBooking({ status: BookingStatus.CONFIRMED }),
      );
      const later = new Date('2999-01-01T12:00:00Z');
      const booking = await service.updateBooking('c1', 'b1', {
        scheduledAt: later,
      });
      expect(booking.status).toBe(BookingStatus.PENDING_PROVIDER);
      expect(booking.scheduledAt).toBe(later);
      expect(planService.assertEligible).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ excludeBookingId: 'b1' }),
      );
    });

    it('refuses to edit an in-progress booking', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeBooking({ status: BookingStatus.IN_PROGRESS }),
      );
      await expect(
        service.updateBooking('c1', 'b1', { notes: 'x' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('cancelBooking', () => {
    it('cancels an upcoming booking', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      expect((await service.cancelBooking('c1', 'b1')).status).toBe(
        BookingStatus.CANCELLED,
      );
    });

    it('refuses to cancel once in progress', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeBooking({ status: BookingStatus.IN_PROGRESS }),
      );
      await expect(service.cancelBooking('c1', 'b1')).rejects.toThrow(
        ConflictException,
      );
    });

    it("404s on someone else's booking", async () => {
      bookingRepo.findOne.mockResolvedValue(null);
      await expect(service.cancelBooking('c2', 'b1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getBooking', () => {
    beforeEach(() => {
      userRepo.findOne.mockResolvedValue({ householdNotes: 'Key under mat' });
    });

    it('shows household notes to the assigned provider only', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      const asProvider = await service.getBooking('pu1', Role.PROVIDER, 'b1');
      expect(asProvider.householdNotes).toBe('Key under mat');
      const asOwner = await service.getBooking('c1', Role.CUSTOMER, 'b1');
      expect(asOwner.householdNotes).toBeUndefined();
    });

    it('404s for a stranger', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      await expect(
        service.getBooking('c9', Role.CUSTOMER, 'b1'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getBooking('pu9', Role.PROVIDER, 'b1'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
