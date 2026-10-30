import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Not, Repository } from 'typeorm';
import { NotificationsService } from '../../notifications/notifications.service';
import { PaymentsService } from '../../payments/payments.service';
import { Provider } from '../../provider/entities/provider.entity';
import { ProviderStatus } from '../../provider/enums/provider-status.enum';
import { User } from '../../user/entities/user.entity';
import { Role } from '../../user/enums/role.enum';
import { CreateBookingDto } from '../dto/create-booking.dto';
import { ListBookingsQueryDto } from '../dto/list-bookings-query.dto';
import { UpdateBookingDto } from '../dto/update-booking.dto';
import { Booking } from '../entities/booking.entity';
import { TrustedProvider } from '../entities/trusted-provider.entity';
import { BookingStatus } from '../enums/booking-status.enum';
import { assertInFuture, assertWithinHorizon } from '../eligibility';
import { BookingPlanService } from './booking-plan.service';

const EDITABLE_STATUSES = [
  BookingStatus.PENDING_PROVIDER,
  BookingStatus.CONFIRMED,
];

// an unpaid booking can also be cancelled
const CANCELLABLE_STATUSES = [
  BookingStatus.PENDING_PAYMENT,
  ...EDITABLE_STATUSES,
];

type TransitionHooks = {
  before?: (booking: Booking) => Promise<void>;
  after?: (booking: Booking) => Promise<void>;
};

@Injectable()
export class BookingService {
  constructor(
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(Provider)
    private readonly providerRepository: Repository<Provider>,
    @InjectRepository(TrustedProvider)
    private readonly trustedProviderRepository: Repository<TrustedProvider>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly bookingPlanService: BookingPlanService,
    private readonly notificationsService: NotificationsService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async createBooking(
    userId: string,
    data: CreateBookingDto,
  ): Promise<{ booking: Booking; checkoutUrl: string }> {
    assertInFuture(data.scheduledAt);
    assertWithinHorizon(data.scheduledAt);
    // price/duration come from the catalog, never from the client
    const subService = await this.bookingPlanService.getSubService(
      data.subServiceId,
    );
    const postcode = await this.bookingPlanService.getPostcode(userId);
    const provider = await this.bookingPlanService.assertEligible(
      data.providerId,
      {
        categoryId: subService.categoryId,
        postcode,
        scheduledAt: data.scheduledAt,
        durationMinutes: subService.baseDurationMinutes,
      },
    );

    // ponytail: check-then-insert, no lock; a Postgres exclusion constraint would close the race
    const booking = await this.bookingRepository.save(
      this.bookingRepository.create({
        userId,
        providerId: provider.id,
        subServiceId: subService.id,
        scheduledAt: data.scheduledAt,
        durationMinutes: subService.baseDurationMinutes,
        priceCents: subService.basePriceCents,
        status: BookingStatus.PENDING_PAYMENT,
        notes: data.notes ?? null,
      }),
    );
    try {
      const checkoutUrl = await this.paymentsService.createCheckout(
        booking,
        subService.name,
      );
      // the provider is told once the payment webhook confirms the card hold
      return { booking, checkoutUrl };
    } catch (error) {
      await this.bookingRepository.delete(booking.id); // no orphan booking if Stripe is down
      throw error;
    }
  }

  async createBookingCheckout(
    userId: string,
    id: string,
  ): Promise<{ checkoutUrl: string }> {
    const booking = await this.getOwnedBooking(userId, id);
    if (booking.status !== BookingStatus.PENDING_PAYMENT) {
      throw new ConflictException('Booking is not waiting for payment!');
    }
    const subService = await this.bookingPlanService.getSubService(
      booking.subServiceId,
    );
    return {
      checkoutUrl: await this.paymentsService.createCheckout(
        booking,
        subService.name,
      ),
    };
  }

  async acceptBooking(userId: string, id: string): Promise<Booking> {
    return this.transitionAsProvider(
      userId,
      id,
      BookingStatus.PENDING_PROVIDER,
      BookingStatus.CONFIRMED,
      'BOOKING_CONFIRMED',
    );
  }

  async declineBooking(userId: string, id: string): Promise<Booking> {
    return this.transitionAsProvider(
      userId,
      id,
      BookingStatus.PENDING_PROVIDER,
      BookingStatus.DECLINED,
      'BOOKING_DECLINED',
      { after: (booking) => this.paymentsService.releaseHold(booking.id) },
    );
  }

  async startBooking(userId: string, id: string): Promise<Booking> {
    return this.transitionAsProvider(
      userId,
      id,
      BookingStatus.CONFIRMED,
      BookingStatus.IN_PROGRESS,
      'BOOKING_STARTED',
    );
  }

  async completeBooking(userId: string, id: string): Promise<Booking> {
    return this.transitionAsProvider(
      userId,
      id,
      BookingStatus.IN_PROGRESS,
      BookingStatus.COMPLETED,
      'BOOKING_COMPLETED',
      // capture first: if Stripe fails the booking stays IN_PROGRESS and the provider retries
      { before: (booking) => this.paymentsService.captureAndPayout(booking) },
    );
  }

  async updateBooking(
    userId: string,
    id: string,
    data: UpdateBookingDto,
  ): Promise<Booking> {
    const booking = await this.getOwnedBooking(userId, id);
    if (!EDITABLE_STATUSES.includes(booking.status)) {
      throw new ConflictException('Only upcoming bookings can be edited!');
    }

    const changes: Partial<Pick<Booking, 'status' | 'scheduledAt' | 'notes'>> =
      {};
    if (
      data.scheduledAt !== undefined &&
      data.scheduledAt.getTime() !== booking.scheduledAt.getTime()
    ) {
      assertInFuture(data.scheduledAt);
      // the card hold started when the booking was made, so measure from then
      assertWithinHorizon(data.scheduledAt, booking.createdAt);
      const subService = await this.bookingPlanService.getSubService(
        booking.subServiceId,
      );
      const postcode = await this.bookingPlanService.getPostcode(userId);
      await this.bookingPlanService.assertEligible(booking.providerId, {
        categoryId: subService.categoryId,
        postcode,
        scheduledAt: data.scheduledAt,
        durationMinutes: booking.durationMinutes,
        excludeBookingId: booking.id,
      });
      changes.scheduledAt = data.scheduledAt;
      // the provider has to re-accept the new time
      changes.status = BookingStatus.PENDING_PROVIDER;
    }
    if (data.notes !== undefined) {
      changes.notes = data.notes;
    }
    // nothing to change: skip the write and the notification
    if (Object.keys(changes).length === 0) {
      return booking;
    }

    const saved = await this.updateWhileStatus(booking, changes);
    this.notificationsService.notify(
      booking.provider.userId,
      'BOOKING_UPDATED',
      { bookingId: booking.id },
    );
    return saved;
  }

  async cancelBooking(userId: string, id: string): Promise<Booking> {
    const booking = await this.getOwnedBooking(userId, id);
    if (!CANCELLABLE_STATUSES.includes(booking.status)) {
      throw new ConflictException('Only upcoming bookings can be cancelled!');
    }
    // updateWhileStatus mutates the booking, so read this first
    const wasPaid = booking.status !== BookingStatus.PENDING_PAYMENT;
    const saved = await this.updateWhileStatus(booking, {
      status: BookingStatus.CANCELLED,
    });
    await this.paymentsService.releaseHold(booking.id);
    // a booking nobody has paid for yet was never shown to the provider
    if (wasPaid) {
      this.notificationsService.notify(
        booking.provider.userId,
        'BOOKING_CANCELLED',
        { bookingId: booking.id },
      );
    }
    return saved;
  }

  // IN_PROGRESS bookings are listed separately (listInProgressBookings) and come back
  // into this list once COMPLETED; an explicit ?status= filter still wins
  async listBookings(
    userId: string,
    role: Role,
    query: ListBookingsQueryDto,
  ): Promise<Booking[]> {
    // providers also never see bookings still waiting for the customer's payment
    const hidden =
      role === Role.PROVIDER
        ? Not(In([BookingStatus.IN_PROGRESS, BookingStatus.PENDING_PAYMENT]))
        : Not(BookingStatus.IN_PROGRESS);
    return this.findForUser(userId, role, query.status ?? hidden);
  }

  async listInProgressBookings(userId: string, role: Role): Promise<Booking[]> {
    return this.findForUser(userId, role, BookingStatus.IN_PROGRESS);
  }

  async getBooking(userId: string, role: Role, id: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id },
      relations: { provider: { user: true }, subService: true },
    });
    const isOwner = booking?.userId === userId;
    const isAssignedProvider =
      role === Role.PROVIDER &&
      booking?.provider.userId === userId &&
      booking.status !== BookingStatus.PENDING_PAYMENT;
    if (!booking || !(isOwner || isAssignedProvider || role === Role.ADMIN)) {
      throw new NotFoundException('Booking not found!');
    }

    // project the provider: the entity carries internals (stripeAccountId, vetting fields)
    const { provider, ...rest } = booking;
    const result = {
      ...rest,
      provider: {
        id: provider.id,
        fullName: provider.user.fullName,
        bio: provider.bio,
      },
      householdNotes: undefined as string | null | undefined,
      customer: undefined as
        { fullName: string | null; address: string | null } | undefined,
    };

    // household notes + job address go to the assigned provider only, read live
    // (not copied onto the booking); email/phone are never loaded
    if (isAssignedProvider) {
      const customer = await this.userRepository.findOne({
        where: { id: booking.userId },
        select: {
          id: true,
          householdNotes: true,
          address: true,
          fullName: true,
        },
      });
      result.householdNotes = customer?.householdNotes ?? null;
      result.customer = {
        fullName: customer?.fullName ?? null,
        address: customer?.address ?? null,
      };
    }
    return result;
  }

  async addTrustedProvider(
    userId: string,
    providerId: string,
  ): Promise<{ message: string }> {
    const hasCompletedJob = await this.bookingRepository.exists({
      where: { userId, providerId, status: BookingStatus.COMPLETED },
    });
    if (!hasCompletedJob) {
      throw new ForbiddenException(
        'You can only trust a provider after a completed job!',
      );
    }
    await this.trustedProviderRepository.upsert({ userId, providerId }, [
      'userId',
      'providerId',
    ]);
    return { message: 'Provider marked as trusted!' };
  }

  private async findForUser(
    userId: string,
    role: Role,
    status: FindOptionsWhere<Booking>['status'],
  ): Promise<Booking[]> {
    if (role === Role.PROVIDER && status === BookingStatus.PENDING_PAYMENT) {
      return [];
    }
    const owner =
      role === Role.PROVIDER
        ? { providerId: (await this.getProviderForUser(userId)).id }
        : { userId };
    return this.bookingRepository.find({
      where: { ...owner, status },
      relations: { subService: true },
      order: { scheduledAt: 'ASC' },
    });
  }

  private async transitionAsProvider(
    userId: string,
    id: string,
    from: BookingStatus,
    to: BookingStatus,
    event: string,
    hooks: TransitionHooks = {},
  ): Promise<Booking> {
    const provider = await this.getProviderForUser(userId);
    // a disabled provider may decline or finish work already on their plate, not take on more
    const takesOnWork =
      to === BookingStatus.CONFIRMED || to === BookingStatus.IN_PROGRESS;
    if (takesOnWork && provider.status !== ProviderStatus.APPROVED) {
      throw new ForbiddenException('Your provider account is not active!');
    }
    const booking = await this.bookingRepository.findOne({
      where: { id, providerId: provider.id },
    });
    if (!booking || booking.status === BookingStatus.PENDING_PAYMENT) {
      throw new NotFoundException('Booking not found!');
    }
    if (booking.status !== from) {
      throw new ConflictException(
        `Booking is ${booking.status}, expected ${from}!`,
      );
    }
    await hooks.before?.(booking);
    const saved = await this.updateWhileStatus(booking, { status: to });
    await hooks.after?.(saved);
    this.notificationsService.notify(booking.userId, event, {
      bookingId: booking.id,
    });
    return saved;
  }

  // compare-and-set: only writes if the booking still has the status/provider we read,
  // so two concurrent requests can't both pass their check and the last one win
  private async updateWhileStatus(
    booking: Booking,
    changes: Partial<Pick<Booking, 'status' | 'scheduledAt' | 'notes'>>,
  ): Promise<Booking> {
    const { affected } = await this.bookingRepository.update(
      {
        id: booking.id,
        status: booking.status,
        providerId: booking.providerId,
      },
      changes,
    );
    if (!affected) {
      throw new ConflictException(
        'Booking was just changed by someone else, please retry!',
      );
    }
    return Object.assign(booking, changes);
  }

  private async getProviderForUser(userId: string): Promise<Provider> {
    const provider = await this.providerRepository.findOne({
      where: { userId },
    });
    if (!provider) {
      throw new NotFoundException('Provider profile not found!');
    }
    return provider;
  }

  private async getOwnedBooking(userId: string, id: string): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id, userId },
      relations: { provider: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found!');
    }
    return booking;
  }
}
