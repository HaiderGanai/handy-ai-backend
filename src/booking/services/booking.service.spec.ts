import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Not } from 'typeorm';
import { NotificationsService } from '../../notifications/notifications.service';
import { Provider } from '../../provider/entities/provider.entity';
import { ProviderStatus } from '../../provider/enums/provider-status.enum';
import { User } from '../../user/entities/user.entity';
import { Role } from '../../user/enums/role.enum';
import { Booking } from '../entities/booking.entity';
import { TrustedProvider } from '../entities/trusted-provider.entity';
import { BookingStatus } from '../enums/booking-status.enum';
import { BookingPlanService } from './booking-plan.service';
import { BookingService } from './booking.service';

describe('BookingService', () => {
  let service: BookingService;

  // freeze "now" so the year-2999 test dates sit inside the 7-day booking horizon
  beforeAll(() => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2998-12-30T00:00:00Z').getTime());
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });
  const bookingRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    exists: jest.fn(),
    update: jest.fn(),
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
    provider: {
      id: 'p1',
      userId: 'pu1',
      bio: 'bio',
      stripeAccountId: 'acct_secret',
      user: { fullName: 'Pro' },
    },
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
    bookingRepo.update.mockResolvedValue({ affected: 1 });
    providerRepo.findOne.mockResolvedValue({
      id: 'p1',
      userId: 'pu1',
      status: ProviderStatus.APPROVED,
    });
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

  describe('booking horizon', () => {
    const tooFar = new Date('2999-02-01T10:00:00Z');

    it('createBooking rejects a time more than 7 days ahead without saving', async () => {
      await expect(
        service.createBooking('c1', {
          subServiceId: 's1',
          scheduledAt: tooFar,
          providerId: 'p1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(bookingRepo.save).not.toHaveBeenCalled();
    });

    it('updateBooking rejects moving a booking more than 7 days ahead', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      await expect(
        service.updateBooking('c1', 'b1', { scheduledAt: tooFar }),
      ).rejects.toThrow(BadRequestException);
      expect(bookingRepo.update).not.toHaveBeenCalled();
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
      userRepo.findOne.mockResolvedValue({
        householdNotes: 'Key under mat',
        address: '1 High St',
        fullName: 'Cust',
      });
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

  describe('addTrustedProvider', () => {
    it('requires a completed job with that provider', async () => {
      bookingRepo.exists.mockResolvedValue(false);
      await expect(service.addTrustedProvider('c1', 'p1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(trustedRepo.upsert).not.toHaveBeenCalled();
    });

    it('upserts so marking twice is harmless', async () => {
      bookingRepo.exists.mockResolvedValue(true);
      await service.addTrustedProvider('c1', 'p1');
      expect(trustedRepo.upsert).toHaveBeenCalledWith(
        { userId: 'c1', providerId: 'p1' },
        ['userId', 'providerId'],
      );
    });
  });

  describe('review fixes', () => {
    it('does not leak provider internals (stripeAccountId etc.) to the customer', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      const result = await service.getBooking('c1', Role.CUSTOMER, 'b1');
      expect(result.provider).toEqual({
        id: 'p1',
        fullName: 'Pro',
        bio: 'bio',
      });
    });

    it('gives the assigned provider the job address, and nobody else', async () => {
      userRepo.findOne.mockResolvedValue({
        householdNotes: 'Key under mat',
        address: '1 High St',
        fullName: 'Cust',
      });
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      const asProvider = await service.getBooking('pu1', Role.PROVIDER, 'b1');
      expect(asProvider.customer).toEqual({
        fullName: 'Cust',
        address: '1 High St',
      });
      const asOwner = await service.getBooking('c1', Role.CUSTOMER, 'b1');
      expect(asOwner.customer).toBeUndefined();
    });

    it('409s a transition when another request changed the booking first', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      bookingRepo.update.mockResolvedValue({ affected: 0 });
      await expect(service.acceptBooking('pu1', 'b1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('409s a cancel when another request changed the booking first', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      bookingRepo.update.mockResolvedValue({ affected: 0 });
      await expect(service.cancelBooking('c1', 'b1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('lets a disabled provider finish or decline work but not take on more', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        userId: 'pu1',
        status: ProviderStatus.DISABLED,
      });
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      await expect(service.acceptBooking('pu1', 'b1')).rejects.toThrow(
        ForbiddenException,
      );
      bookingRepo.findOne.mockResolvedValue(
        makeBooking({ status: BookingStatus.CONFIRMED }),
      );
      await expect(service.startBooking('pu1', 'b1')).rejects.toThrow(
        ForbiddenException,
      );
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      expect((await service.declineBooking('pu1', 'b1')).status).toBe(
        BookingStatus.DECLINED,
      );
    });
  });

  describe('listing', () => {
    it('hides IN_PROGRESS bookings from the all-bookings list by default', async () => {
      bookingRepo.find.mockResolvedValue([]);
      await service.listBookings('c1', Role.CUSTOMER, {});
      expect(bookingRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'c1', status: Not(BookingStatus.IN_PROGRESS) },
        }),
      );
    });

    it('still honours an explicit status filter, including IN_PROGRESS', async () => {
      bookingRepo.find.mockResolvedValue([]);
      await service.listBookings('c1', Role.CUSTOMER, {
        status: BookingStatus.IN_PROGRESS,
      });
      expect(bookingRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'c1', status: BookingStatus.IN_PROGRESS },
        }),
      );
    });

    it("lists only the customer's IN_PROGRESS bookings", async () => {
      bookingRepo.find.mockResolvedValue([]);
      await service.listInProgressBookings('c1', Role.CUSTOMER);
      expect(bookingRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'c1', status: BookingStatus.IN_PROGRESS },
        }),
      );
    });

    it("lists only the provider's own IN_PROGRESS jobs", async () => {
      bookingRepo.find.mockResolvedValue([]);
      await service.listInProgressBookings('pu1', Role.PROVIDER);
      expect(bookingRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { providerId: 'p1', status: BookingStatus.IN_PROGRESS },
        }),
      );
    });
  });
});
