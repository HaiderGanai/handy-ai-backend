import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SubService } from '../../catalog/entities/sub-service.entity';
import { Provider } from '../../provider/entities/provider.entity';
import { ProviderStatus } from '../../provider/enums/provider-status.enum';
import { User } from '../../user/entities/user.entity';
import { PlanBookingDto } from '../dto/plan-booking.dto';
import { Booking } from '../entities/booking.entity';
import { TrustedProvider } from '../entities/trusted-provider.entity';
import { ACTIVE_BOOKING_STATUSES } from '../enums/booking-status.enum';
import {
  assertInFuture,
  assertWithinHorizon,
  coversPostcode,
  EligibilityContext,
  isWithinAvailability,
  overlaps,
} from '../eligibility';

export interface BookingPlan {
  provider: { id: string; fullName: string | null; bio: string };
  subService: { id: string; name: string };
  scheduledAt: Date;
  durationMinutes: number;
  priceCents: number;
  isTrustedProvider: boolean;
}

// ponytail: deterministic stand-in for the GPT-4 plan-generation layer (spec §3).
// Replace planBooking's body with the AI service call when that phase starts;
// the controller/DTO contract (service+date/time in, plan out) stays the same.
@Injectable()
export class BookingPlanService {
  constructor(
    @InjectRepository(Provider)
    private readonly providerRepository: Repository<Provider>,
    @InjectRepository(SubService)
    private readonly subServiceRepository: Repository<SubService>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(TrustedProvider)
    private readonly trustedProviderRepository: Repository<TrustedProvider>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async planBooking(
    userId: string,
    data: PlanBookingDto,
  ): Promise<BookingPlan> {
    assertInFuture(data.scheduledAt);
    assertWithinHorizon(data.scheduledAt);
    const subService = await this.getSubService(data.subServiceId);
    const postcode = await this.getPostcode(userId);
    const context: EligibilityContext = {
      categoryId: subService.categoryId,
      postcode,
      scheduledAt: data.scheduledAt,
      durationMinutes: subService.baseDurationMinutes,
    };

    const providers = await this.providerRepository.find({
      where: { status: ProviderStatus.APPROVED },
      relations: { user: true, categories: true, availability: true },
      order: { createdAt: 'ASC' },
    });
    const trusted = await this.trustedProviderRepository.find({
      where: { userId },
    });
    const trustedIds = new Set(trusted.map((entry) => entry.providerId));
    // trusted providers first (stable sort keeps the rest in creation order)
    providers.sort(
      (a, b) => Number(trustedIds.has(b.id)) - Number(trustedIds.has(a.id)),
    );

    for (const provider of providers) {
      if (await this.isEligible(provider, context)) {
        return {
          provider: {
            id: provider.id,
            fullName: provider.user.fullName,
            bio: provider.bio,
          },
          subService: { id: subService.id, name: subService.name },
          scheduledAt: data.scheduledAt,
          durationMinutes: subService.baseDurationMinutes,
          priceCents: subService.basePriceCents,
          isTrustedProvider: trustedIds.has(provider.id),
        };
      }
    }
    throw new NotFoundException('No provider available for that time!');
  }

  async getSubService(id: string): Promise<SubService> {
    const subService = await this.subServiceRepository.findOne({
      where: { id },
    });
    if (!subService) {
      throw new NotFoundException('Service not found!');
    }
    return subService;
  }

  async getPostcode(userId: string): Promise<string> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user?.postcode) {
      throw new BadRequestException('Add a postcode to your profile first!');
    }
    return user.postcode;
  }

  async isEligible(
    provider: Provider,
    context: EligibilityContext,
  ): Promise<boolean> {
    if (
      provider.status !== ProviderStatus.APPROVED ||
      !provider.categories.some((c) => c.id === context.categoryId) ||
      !coversPostcode(provider.postcodeCoverage, context.postcode) ||
      !isWithinAvailability(
        provider.availability,
        context.scheduledAt,
        context.durationMinutes,
      )
    ) {
      return false;
    }
    // ponytail: loads the provider's active bookings and filters in JS; add a date-range query if lists grow
    const active = await this.bookingRepository.find({
      where: {
        providerId: provider.id,
        status: In(ACTIVE_BOOKING_STATUSES),
      },
    });
    return !active.some(
      (booking) =>
        booking.id !== context.excludeBookingId &&
        overlaps(
          booking.scheduledAt,
          booking.durationMinutes,
          context.scheduledAt,
          context.durationMinutes,
        ),
    );
  }

  async assertEligible(
    providerId: string,
    context: EligibilityContext,
  ): Promise<Provider> {
    const provider = await this.providerRepository.findOne({
      where: { id: providerId },
      relations: { categories: true, availability: true },
    });
    if (!provider) {
      throw new NotFoundException('Provider not found!');
    }
    if (!(await this.isEligible(provider, context))) {
      throw new ConflictException('Provider is not available for that time!');
    }
    return provider;
  }
}
