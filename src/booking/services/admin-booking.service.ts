import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationsService } from '../../notifications/notifications.service';
import { ListBookingsQueryDto } from '../dto/list-bookings-query.dto';
import { ReassignBookingDto } from '../dto/reassign-booking.dto';
import { Booking } from '../entities/booking.entity';
import { BookingStatus } from '../enums/booking-status.enum';
import { BookingPlanService } from './booking-plan.service';

@Injectable()
export class AdminBookingService {
  constructor(
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    private readonly bookingPlanService: BookingPlanService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async listBookings(query: ListBookingsQueryDto): Promise<Booking[]> {
    return this.bookingRepository.find({
      where: query.status ? { status: query.status } : {},
      relations: { subService: true },
      order: { scheduledAt: 'ASC' },
    });
  }

  async reassignBooking(
    id: string,
    data: ReassignBookingDto,
  ): Promise<Booking> {
    // no `provider` relation loaded on purpose: a stale relation would override the new providerId on save
    const booking = await this.bookingRepository.findOne({
      where: { id },
      relations: { subService: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found!');
    }
    if (
      booking.status !== BookingStatus.PENDING_PROVIDER &&
      booking.status !== BookingStatus.CONFIRMED
    ) {
      throw new ConflictException(
        'Only pending or confirmed bookings can be reassigned!',
      );
    }

    const postcode = await this.bookingPlanService.getPostcode(booking.userId);
    const provider = await this.bookingPlanService.assertEligible(
      data.providerId,
      {
        categoryId: booking.subService.categoryId,
        postcode,
        scheduledAt: booking.scheduledAt,
        durationMinutes: booking.durationMinutes,
        excludeBookingId: booking.id,
      },
    );

    booking.providerId = provider.id;
    booking.status = BookingStatus.PENDING_PROVIDER;
    const saved = await this.bookingRepository.save(booking);
    this.notificationsService.notify(provider.userId, 'BOOKING_REQUESTED', {
      bookingId: booking.id,
    });
    this.notificationsService.notify(booking.userId, 'BOOKING_REASSIGNED', {
      bookingId: booking.id,
    });
    return saved;
  }
}
