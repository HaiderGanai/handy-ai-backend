import { NotFoundException } from '@nestjs/common';
import { BookingPlanService } from '../booking/services/booking-plan.service';
import { BookingService } from '../booking/services/booking.service';
import { CatalogService } from '../catalog/catalog.service';
import { Role } from '../user/enums/role.enum';
import { HandyToolsService } from './handy-tools.service';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('HandyToolsService', () => {
  const catalog = { getServiceCategories: jest.fn() };
  const planService = { planBooking: jest.fn() };
  const bookingService = { listBookings: jest.fn() };
  const cache = { set: jest.fn() };
  const tools = new HandyToolsService(
    catalog as unknown as CatalogService,
    planService as unknown as BookingPlanService,
    bookingService as unknown as BookingService,
    cache as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('exposes exactly the three read/propose tools', () => {
    expect(tools.definitions.map((d) => d.name).sort()).toEqual([
      'get_my_bookings',
      'list_services',
      'propose_plan',
    ]);
  });

  it('has no user or customer id parameter on any tool', () => {
    const json = JSON.stringify(tools.definitions).toLowerCase();
    expect(json).not.toContain('userid');
    expect(json).not.toContain('customerid');
  });

  it('list_services returns categories with their sub-services', async () => {
    catalog.getServiceCategories.mockResolvedValue([
      {
        name: 'Cleaning',
        subServices: [
          {
            id: UUID,
            name: 'Regular home clean',
            basePriceCents: 8000,
            baseDurationMinutes: 120,
          },
        ],
      },
    ]);
    const { result } = await tools.execute('u1', 'list_services', '{}');
    expect(result).toEqual([
      {
        category: 'Cleaning',
        services: [
          {
            id: UUID,
            name: 'Regular home clean',
            priceCents: 8000,
            durationMinutes: 120,
          },
        ],
      },
    ]);
  });

  describe('propose_plan', () => {
    const plan = {
      provider: { id: 'p1', fullName: 'Marcus', bio: 'Ten years' },
      subService: { id: UUID, name: 'Regular home clean' },
      scheduledAt: new Date('2030-03-06T10:00:00Z'),
      durationMinutes: 120,
      priceCents: 8000,
      isTrustedProvider: false,
    };
    const args = JSON.stringify({
      subServiceId: UUID,
      scheduledAt: '2030-03-06T10:00:00Z',
      notes: 'bring ladders',
    });

    it('stores the plan under handy_plan:<userId>:<planId> for 30 minutes and returns a card', async () => {
      planService.planBooking.mockResolvedValue(plan);
      const { plan: card, result } = await tools.execute(
        'u1',
        'propose_plan',
        args,
      );
      expect(planService.planBooking).toHaveBeenCalledWith('u1', {
        subServiceId: UUID,
        scheduledAt: new Date('2030-03-06T10:00:00Z'),
        notes: 'bring ladders',
      });
      expect(card?.planId).toMatch(/^[0-9a-f-]{36}$/);
      expect(card?.provider).toEqual(plan.provider);
      expect(cache.set).toHaveBeenCalledWith(
        `handy_plan:u1:${card?.planId}`,
        {
          subServiceId: UUID,
          providerId: 'p1',
          scheduledAt: new Date('2030-03-06T10:00:00Z'),
          notes: 'bring ladders',
        },
        30 * 60 * 1000,
      );
      expect(JSON.stringify(result)).toContain('Marcus');
    });

    it.each([
      [
        'a non-UUID subServiceId',
        { subServiceId: 'nope', scheduledAt: '2030-03-06T10:00:00Z' },
      ],
      [
        'a non-date scheduledAt',
        { subServiceId: UUID, scheduledAt: 'tomorrow' },
      ],
      [
        'a time without an offset',
        { subServiceId: UUID, scheduledAt: '2030-03-06T10:00:00' },
      ],
    ])('returns an error result, not a throw, for %s', async (_n, bad) => {
      const out = await tools.execute(
        'u1',
        'propose_plan',
        JSON.stringify(bad),
      );
      expect(out.result).toEqual({ error: expect.any(String) });
      expect(out.plan).toBeUndefined();
      expect(planService.planBooking).not.toHaveBeenCalled();
    });

    it('surfaces a service error as an error result', async () => {
      planService.planBooking.mockRejectedValue(
        new NotFoundException('No provider available for that time!'),
      );
      const out = await tools.execute('u1', 'propose_plan', args);
      expect(out.result).toEqual({
        error: 'No provider available for that time!',
      });
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('ignores a userId smuggled into the arguments', async () => {
      planService.planBooking.mockResolvedValue(plan);
      await tools.execute(
        'u1',
        'propose_plan',
        JSON.stringify({ ...JSON.parse(args), userId: 'victim' }),
      );
      expect(planService.planBooking.mock.calls[0][0]).toBe('u1');
    });
  });

  it('get_my_bookings queries only for the caller and projects the rows', async () => {
    bookingService.listBookings.mockResolvedValue([
      {
        id: 'b1',
        status: 'CONFIRMED',
        scheduledAt: new Date('2030-03-06T10:00:00Z'),
        priceCents: 8000,
        subService: { name: 'Regular home clean' },
        providerId: 'secret',
      },
    ]);
    const { result } = await tools.execute(
      'u1',
      'get_my_bookings',
      JSON.stringify({ userId: 'victim' }),
    );
    expect(bookingService.listBookings).toHaveBeenCalledWith(
      'u1',
      Role.CUSTOMER,
      {},
    );
    expect(result).toEqual([
      {
        id: 'b1',
        status: 'CONFIRMED',
        scheduledAt: new Date('2030-03-06T10:00:00Z'),
        priceCents: 8000,
        serviceName: 'Regular home clean',
      },
    ]);
  });

  it('returns error results for an unknown tool and for malformed JSON', async () => {
    expect((await tools.execute('u1', 'create_booking', '{}')).result).toEqual({
      error: expect.any(String),
    });
    expect((await tools.execute('u1', 'propose_plan', '{oops')).result).toEqual(
      {
        error: expect.any(String),
      },
    );
  });
});
