import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SubService } from '../../catalog/entities/sub-service.entity';
import { Provider } from '../../provider/entities/provider.entity';
import { ProviderStatus } from '../../provider/enums/provider-status.enum';
import { User } from '../../user/entities/user.entity';
import { Booking } from '../entities/booking.entity';
import { TrustedProvider } from '../entities/trusted-provider.entity';
import { BookingPlanService } from './booking-plan.service';

describe('BookingPlanService', () => {
  let service: BookingPlanService;

  // freeze "now" so the 2030 test dates sit inside the 7-day booking horizon
  beforeAll(() => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2030-01-03T00:00:00Z').getTime());
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });
  const providerRepo = { find: jest.fn(), findOne: jest.fn() };
  const subServiceRepo = { findOne: jest.fn() };
  const bookingRepo = { find: jest.fn() };
  const trustedRepo = { find: jest.fn() };
  const userRepo = { findOne: jest.fn() };

  const scheduledAt = new Date('2030-01-07T10:00:00Z'); // Monday
  const request = { subServiceId: 's1', scheduledAt };
  const makeProvider = (id: string, over: object = {}) => ({
    id,
    userId: `u-${id}`,
    bio: 'bio',
    status: ProviderStatus.APPROVED,
    postcodeCoverage: ['SW1A 1AA'],
    categories: [{ id: 'cat1' }],
    availability: [
      { dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' },
    ],
    user: { fullName: id },
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    subServiceRepo.findOne.mockResolvedValue({
      id: 's1',
      name: 'Deep clean',
      categoryId: 'cat1',
      basePriceCents: 12000,
      baseDurationMinutes: 60,
    });
    userRepo.findOne.mockResolvedValue({ postcode: 'sw1a1aa' });
    bookingRepo.find.mockResolvedValue([]);
    trustedRepo.find.mockResolvedValue([]);
    const module = await Test.createTestingModule({
      providers: [
        BookingPlanService,
        { provide: getRepositoryToken(Provider), useValue: providerRepo },
        { provide: getRepositoryToken(SubService), useValue: subServiceRepo },
        { provide: getRepositoryToken(Booking), useValue: bookingRepo },
        { provide: getRepositoryToken(TrustedProvider), useValue: trustedRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();
    service = module.get(BookingPlanService);
  });

  it('rejects a customer with no postcode on their profile', async () => {
    userRepo.findOne.mockResolvedValue({ postcode: null });
    await expect(service.planBooking('c1', request)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a time more than 7 days ahead', async () => {
    await expect(
      service.planBooking('c1', {
        ...request,
        scheduledAt: new Date('2030-02-01T10:00:00Z'),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a time in the past', async () => {
    await expect(
      service.planBooking('c1', {
        ...request,
        scheduledAt: new Date('2000-01-01T10:00:00Z'),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('prefers the trusted provider over an earlier eligible one', async () => {
    providerRepo.find.mockResolvedValue([makeProvider('a'), makeProvider('b')]);
    trustedRepo.find.mockResolvedValue([{ providerId: 'b' }]);
    const plan = await service.planBooking('c1', request);
    expect(plan.provider.id).toBe('b');
    expect(plan.isTrustedProvider).toBe(true);
    expect(plan.priceCents).toBe(12000);
    expect(plan.durationMinutes).toBe(60);
  });

  it('skips providers that are out of area, off-category or double-booked', async () => {
    providerRepo.find.mockResolvedValue([
      makeProvider('wrong-area', { postcodeCoverage: ['E1 6AN'] }),
      makeProvider('wrong-category', { categories: [{ id: 'other' }] }),
      makeProvider('busy'),
      makeProvider('free'),
    ]);
    bookingRepo.find.mockImplementation(
      ({ where }: { where: { providerId: string } }) =>
        Promise.resolve(
          where.providerId === 'busy'
            ? [{ id: 'x', scheduledAt, durationMinutes: 60 }]
            : [],
        ),
    );
    const plan = await service.planBooking('c1', request);
    expect(plan.provider.id).toBe('free');
  });

  it('throws NotFound when nobody is eligible', async () => {
    providerRepo.find.mockResolvedValue([]);
    await expect(service.planBooking('c1', request)).rejects.toThrow(
      NotFoundException,
    );
  });
});
