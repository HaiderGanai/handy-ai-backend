import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  validate,
} from 'class-validator';
import type { Cache } from 'cache-manager';
import { randomUUID } from 'node:crypto';
import { BookingStatus } from '../booking/enums/booking-status.enum';
import { BookingPlanService } from '../booking/services/booking-plan.service';
import { BookingService } from '../booking/services/booking.service';
import { CatalogService } from '../catalog/catalog.service';
import { CacheKeys } from '../common/cache-keys';
import { Role } from '../user/enums/role.enum';
import { LlmToolDefinition } from './llm.service';

const PLAN_TTL_MS = 30 * 60 * 1000;

export interface PlanCard {
  planId: string;
  provider: { id: string; fullName: string | null; bio: string | null };
  subService: { id: string; name: string };
  scheduledAt: Date;
  durationMinutes: number;
  priceCents: number;
  isTrustedProvider: boolean;
  expiresAt: Date;
}

// what propose_plan keeps server-side until the customer taps Confirm
export interface StoredPlan {
  subServiceId: string;
  providerId: string;
  scheduledAt: Date;
  notes?: string;
}

export interface ToolOutcome {
  result: unknown;
  plan?: PlanCard;
}

class ProposePlanArgs {
  @IsUUID()
  subServiceId: string;

  @IsISO8601({ strict: true })
  @Matches(/(Z|[+-]\d{2}:?\d{2})$/, {
    message: 'scheduledAt must be an ISO-8601 time with a UTC offset',
  })
  scheduledAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

class GetMyBookingsArgs {
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;
}

@Injectable()
export class HandyToolsService {
  constructor(
    private readonly catalogService: CatalogService,
    private readonly bookingPlanService: BookingPlanService,
    private readonly bookingService: BookingService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // deliberately no create/edit/cancel tool and no user id parameter: the caller's id is
  // always passed to execute() by the server
  readonly definitions: LlmToolDefinition[] = [
    {
      name: 'list_services',
      description:
        'List the bookable services with their ids, flat prices (USD cents) and durations.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'propose_plan',
      description:
        'Find the best available provider for a service at a time and propose a booking plan. Does not book anything.',
      parameters: {
        type: 'object',
        properties: {
          subServiceId: {
            type: 'string',
            description: 'id from list_services',
          },
          scheduledAt: {
            type: 'string',
            description:
              'Start time, ISO-8601 with UTC offset, e.g. 2030-03-06T10:00:00+05:00',
          },
          notes: { type: 'string', description: 'Optional job notes' },
        },
        required: ['subServiceId', 'scheduledAt'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_my_bookings',
      description: "List the customer's own bookings, optionally by status.",
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: Object.values(BookingStatus) },
        },
        additionalProperties: false,
      },
    },
  ];

  // never throws: every failure becomes a result the model can explain to the customer
  async execute(
    userId: string,
    name: string,
    rawArguments: string,
  ): Promise<ToolOutcome> {
    try {
      const args: unknown = JSON.parse(rawArguments || '{}');
      switch (name) {
        case 'list_services':
          return { result: await this.listServices() };
        case 'propose_plan':
          return await this.proposePlan(userId, args);
        case 'get_my_bookings':
          return { result: await this.getMyBookings(userId, args) };
        default:
          return { result: { error: `Unknown tool ${name}!` } };
      }
    } catch (error) {
      const message =
        error instanceof SyntaxError
          ? 'Tool arguments were not valid JSON!'
          : error instanceof Error
            ? error.message
            : 'Tool failed!';
      return { result: { error: message } };
    }
  }

  private async listServices() {
    const categories = await this.catalogService.getServiceCategories();
    return categories.map((category) => ({
      category: category.name,
      services: category.subServices.map((s) => ({
        id: s.id,
        name: s.name,
        priceCents: s.basePriceCents,
        durationMinutes: s.baseDurationMinutes,
      })),
    }));
  }

  private async proposePlan(
    userId: string,
    raw: unknown,
  ): Promise<ToolOutcome> {
    const args = await this.parse(ProposePlanArgs, raw);
    const scheduledAt = new Date(args.scheduledAt);
    const plan = await this.bookingPlanService.planBooking(userId, {
      subServiceId: args.subServiceId,
      scheduledAt,
      notes: args.notes,
    });

    //keep what Confirm needs server-side; the model never sees or sets the provider id to book
    const planId = randomUUID();
    const stored: StoredPlan = {
      subServiceId: plan.subService.id,
      providerId: plan.provider.id,
      scheduledAt: plan.scheduledAt,
      notes: args.notes,
    };
    await this.cache.set(
      CacheKeys.handyPlan(userId, planId),
      stored,
      PLAN_TTL_MS,
    );
    const card: PlanCard = {
      planId,
      provider: plan.provider,
      subService: plan.subService,
      scheduledAt: plan.scheduledAt,
      durationMinutes: plan.durationMinutes,
      priceCents: plan.priceCents,
      isTrustedProvider: plan.isTrustedProvider,
      expiresAt: new Date(Date.now() + PLAN_TTL_MS),
    };
    return {
      plan: card,
      result: {
        proposed: true,
        provider: plan.provider,
        service: plan.subService.name,
        scheduledAt: plan.scheduledAt,
        durationMinutes: plan.durationMinutes,
        priceCents: plan.priceCents,
        isTrustedProvider: plan.isTrustedProvider,
        note: 'Not booked yet: the customer must tap Confirm.',
      },
    };
  }

  private async getMyBookings(userId: string, raw: unknown) {
    const args = await this.parse(GetMyBookingsArgs, raw);
    const bookings = await this.bookingService.listBookings(
      userId,
      Role.CUSTOMER,
      args.status ? { status: args.status } : {},
    );
    return bookings.map((b) => ({
      id: b.id,
      status: b.status,
      scheduledAt: b.scheduledAt,
      priceCents: b.priceCents,
      serviceName: b.subService.name,
    }));
  }

  private async parse<T extends object>(
    type: new () => T,
    raw: unknown,
  ): Promise<T> {
    const instance = plainToInstance(type, raw ?? {});
    const errors = await validate(instance, { whitelist: true });
    if (errors.length > 0) {
      const first = Object.values(errors[0].constraints ?? {})[0];
      throw new Error(first ?? 'Invalid tool arguments!');
    }
    return instance;
  }
}
