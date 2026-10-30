import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Not, Repository } from 'typeorm';
import { NotificationsService } from '../../notifications/notifications.service';
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
  ) {}

  async createBooking(
    userId: string,
    data: CreateBookingDto,
  ): Promise<Booking> {
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
        status: BookingStatus.PENDING_PROVIDER,
        notes: data.notes ?? null,
      }),
    );
    this.notificationsService.notify(provider.userId, 'BOOKING_REQUESTED', {
      bookingId: booking.id,
    });
    return booking;
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
    // Phase 5: capture the PaymentIntent here (releases the hold + 80/20 split)
    return this.transitionAsProvider(
      userId,
      id,
      BookingStatus.IN_PROGRESS,
      BookingStatus.COMPLETED,
      'BOOKING_COMPLETED',
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
      assertWithinHorizon(data.scheduledAt);
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
    if (!EDITABLE_STATUSES.includes(booking.status)) {
      throw new ConflictException('Only upcoming bookings can be cancelled!');
    }
    const saved = await this.updateWhileStatus(booking, {
      status: BookingStatus.CANCELLED,
    });
    this.notificationsService.notify(
      booking.provider.userId,
      'BOOKING_CANCELLED',
      { bookingId: booking.id },
    );
    return saved;
  }

  // IN_PROGRESS bookings are listed separately (listInProgressBookings) and come back
  // into this list once COMPLETED; an explicit ?status= filter still wins
  async listBookings(
    userId: string,
    role: Role,
    query: ListBookingsQueryDto,
  ): Promise<Booking[]> {
    return this.findForUser(
      userId,
      role,
      query.status ?? Not(BookingStatus.IN_PROGRESS),
    );
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
      role === Role.PROVIDER && booking?.provider.userId === userId;
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
    if (!booking) {
      throw new NotFoundException('Booking not found!');
    }
    if (booking.status !== from) {
      throw new ConflictException(
        `Booking is ${booking.status}, expected ${from}!`,
      );
    }
    const saved = await this.updateWhileStatus(booking, { status: to });
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
