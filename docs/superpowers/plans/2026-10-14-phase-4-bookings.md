# Phase 4 — Bookings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers get a deterministic booking plan, confirm it, and providers accept/decline/start/complete it; customers edit/cancel and mark trusted providers; admins list/reassign.

**Architecture:** New `src/booking/` module mirroring `src/provider/`. `BookingPlanService` owns eligibility/matching (the GPT-4 stand-in, the only file swapped later); `BookingService` owns the lifecycle state machine; `AdminBookingService` lists/reassigns. A log-only `NotificationsService` is the Phase 7 hook.

**Tech Stack:** NestJS 11, TypeORM 0.3.x (migrations only), class-validator, Jest.

**Spec:** `docs/superpowers/specs/2026-10-14-phase-4-bookings-design.md`

## Global Constraints

- Controller method name == service method name (GUIDE.md §2.1). Routes kebab-case with leading slash. No try/catch in controllers.
- Throw Nest built-ins; messages end with `!` (matches existing code, e.g. `'Provider not found!'`).
- Global prefix `api/v1` and global `ValidationPipe({ whitelist, transform })` already exist — don't re-add.
- Prices are `priceCents` (int, USD cents). Status enum values exactly: `PENDING_PROVIDER | CONFIRMED | DECLINED | IN_PROGRESS | COMPLETED | CANCELLED`.
- Availability is compared in UTC. Overlap statuses: `PENDING_PROVIDER | CONFIRMED | IN_PROGRESS`.
- `DTO → entity` merges must check `!== undefined` per field (CLAUDE.md Phase 1 gotcha: DTO class fields exist as own `undefined` properties).
- When saving a booking, never load a stale `provider` relation and also change `providerId` — the relation wins and silently reverts the FK.
- Migrations only, generated with `npm run migration:generate`; verify the tables exist after running (CLAUDE.md Phase 2 gotcha).
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Customer with no `postcode` on profile requests a plan → 400, not a crash or empty match (Task 2).
- Postcode `sw1a1aa` must match coverage `SW1A 1AA` (case/space-insensitive) (Task 2).
- Booking that would run past midnight is outside any availability window (Task 2).
- Back-to-back bookings (one ends exactly when the next starts) are not an overlap (Task 2).
- Editing only `notes` on a `CONFIRMED` booking keeps it `CONFIRMED`; only a time change resets to `PENDING_PROVIDER` (Task 3).
- Known untested gap: admin `DELETE /admin/providers/:id` on a provider with bookings hits the FK (`RESTRICT`) → 500. Out of this phase's scope; note in docs.

## File Structure

```
src/notifications/notifications.service.ts      log-only notify() (Phase 7 swaps impl)
src/notifications/notifications.module.ts
src/booking/enums/booking-status.enum.ts        BookingStatus + ACTIVE_BOOKING_STATUSES
src/booking/entities/booking.entity.ts
src/booking/entities/trusted-provider.entity.ts
src/booking/eligibility.ts                      pure helpers: coversPostcode, isWithinAvailability, overlaps, assertInFuture
src/booking/dto/plan-booking.dto.ts             (+ create-booking, update-booking, list-bookings-query, reassign-booking)
src/booking/services/booking-plan.service.ts
src/booking/services/booking.service.ts
src/booking/services/admin-booking.service.ts
src/booking/booking.controller.ts
src/booking/trusted-provider.controller.ts
src/booking/admin-booking.controller.ts
src/booking/booking.module.ts
src/database/migrations/<ts>-Phase4Bookings.ts  (generated)
```

---

### Task 1: Foundations — enum, entities, notifications, module, migration

**Files:**
- Create: `src/booking/enums/booking-status.enum.ts`, `src/booking/entities/booking.entity.ts`, `src/booking/entities/trusted-provider.entity.ts`, `src/notifications/notifications.service.ts`, `src/notifications/notifications.module.ts`, `src/booking/booking.module.ts`
- Modify: `src/app.module.ts`
- Generate: `src/database/migrations/*-Phase4Bookings.ts`

**Interfaces:**
- Produces: `BookingStatus`, `ACTIVE_BOOKING_STATUSES`, `Booking`, `TrustedProvider`, `NotificationsService.notify(userId: string, event: string, payload?: Record<string, unknown>): void`.

- [ ] **Step 1: Create the enum**

`src/booking/enums/booking-status.enum.ts`
```ts
export enum BookingStatus {
  PENDING_PROVIDER = 'PENDING_PROVIDER',
  CONFIRMED = 'CONFIRMED',
  DECLINED = 'DECLINED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

// statuses that hold a provider's time slot
export const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.PENDING_PROVIDER,
  BookingStatus.CONFIRMED,
  BookingStatus.IN_PROGRESS,
];
```

- [ ] **Step 2: Create the entities**

`src/booking/entities/booking.entity.ts`
```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SubService } from '../../catalog/entities/sub-service.entity';
import { Provider } from '../../provider/entities/provider.entity';
import { User } from '../../user/entities/user.entity';
import { BookingStatus } from '../enums/booking-status.enum';

@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  providerId: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'providerId' })
  provider: Provider;

  @Column({ type: 'uuid' })
  subServiceId: string;

  @ManyToOne(() => SubService, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subServiceId' })
  subService: SubService;

  @Column({ type: 'timestamptz' })
  scheduledAt: Date;

  @Column({ type: 'int' })
  durationMinutes: number;

  // flat-rate price in USD cents, copied from the sub-service at confirm time
  @Column({ type: 'int' })
  priceCents: number;

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.PENDING_PROVIDER,
  })
  status: BookingStatus;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
```

`src/booking/entities/trusted-provider.entity.ts`
```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Provider } from '../../provider/entities/provider.entity';
import { User } from '../../user/entities/user.entity';

@Entity('trusted_providers')
@Unique(['userId', 'providerId'])
export class TrustedProvider {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  providerId: string;

  @ManyToOne(() => Provider, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'providerId' })
  provider: Provider;

  @CreateDateColumn()
  createdAt: Date;
}
```

- [ ] **Step 3: Notifications (log-only hook)**

`src/notifications/notifications.service.ts`
```ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  // ponytail: log-only until Phase 7 wires FCM; callers keep this signature
  notify(
    userId: string,
    event: string,
    payload: Record<string, unknown> = {},
  ): void {
    this.logger.log(`notify ${userId} ${event} ${JSON.stringify(payload)}`);
  }
}
```

`src/notifications/notifications.module.ts`
```ts
import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
```

- [ ] **Step 4: Module skeleton and registration**

`src/booking/booking.module.ts`
```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubService } from '../catalog/entities/sub-service.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Provider } from '../provider/entities/provider.entity';
import { User } from '../user/entities/user.entity';
import { Booking } from './entities/booking.entity';
import { TrustedProvider } from './entities/trusted-provider.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      TrustedProvider,
      Provider,
      SubService,
      User,
    ]),
    NotificationsModule,
  ],
})
export class BookingModule {}
```

In `src/app.module.ts` add `import { BookingModule } from './booking/booking.module';` and append `BookingModule` to `imports` after `ProviderModule`.

- [ ] **Step 5: Generate and run the migration, verify tables**

```bash
npm run build
npm run migration:generate -- src/database/migrations/Phase4Bookings
npm run migration:run
set -a; . ./.env; set +a
psql "$DATABASE_URL" -c '\d bookings' -c '\d trusted_providers'
```
Expected: both tables listed; `bookings` has `bookings_status_enum`; `trusted_providers` has a unique constraint on (`userId`,`providerId`). If the migration is empty, the entities were not picked up — check the build ran.

- [ ] **Step 6: Commit**

```bash
git add src/booking src/notifications src/app.module.ts src/database/migrations
git commit -m "Phase 4: booking entities, notifications hook, migration

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Eligibility + `POST /bookings/plan`

**Files:**
- Create: `src/booking/eligibility.ts`, `src/booking/eligibility.spec.ts`, `src/booking/dto/plan-booking.dto.ts`, `src/booking/services/booking-plan.service.ts`, `src/booking/services/booking-plan.service.spec.ts`, `src/booking/booking.controller.ts`
- Modify: `src/booking/booking.module.ts`

**Interfaces:**
- Consumes: Task 1 entities/enums.
- Produces:
  - `coversPostcode(coverage: string[], postcode: string): boolean`
  - `isWithinAvailability(slots: {dayOfWeek:number;startTime:string;endTime:string}[], start: Date, durationMinutes: number): boolean`
  - `overlaps(aStart: Date, aMinutes: number, bStart: Date, bMinutes: number): boolean`
  - `assertInFuture(date: Date): void` (throws `BadRequestException`)
  - `interface EligibilityContext { categoryId: string; postcode: string; scheduledAt: Date; durationMinutes: number; excludeBookingId?: string }`
  - `BookingPlanService`: `planBooking(userId: string, data: PlanBookingDto): Promise<BookingPlan>`, `getSubService(id: string): Promise<SubService>`, `getPostcode(userId: string): Promise<string>`, `isEligible(provider: Provider, ctx: EligibilityContext): Promise<boolean>`, `assertEligible(providerId: string, ctx: EligibilityContext): Promise<Provider>` (404 if provider missing, 409 if not eligible)
  - `PlanBookingDto { subServiceId: string; scheduledAt: Date; notes?: string }`

- [ ] **Step 1: Write the failing pure-helper tests**

`src/booking/eligibility.spec.ts`
```ts
import { BadRequestException } from '@nestjs/common';
import {
  assertInFuture,
  coversPostcode,
  isWithinAvailability,
  overlaps,
} from './eligibility';

describe('eligibility helpers', () => {
  // 2030-01-07 is a Monday (dayOfWeek 1)
  const monday = (time: string) => new Date(`2030-01-07T${time}:00Z`);
  const slot = { dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' };

  it('matches postcodes ignoring case and spaces', () => {
    expect(coversPostcode(['SW1A 1AA'], 'sw1a1aa')).toBe(true);
    expect(coversPostcode(['SW1A 1AA'], 'SW1A 2AA')).toBe(false);
  });

  it('requires the whole job inside one availability window', () => {
    expect(isWithinAvailability([slot], monday('10:00'), 60)).toBe(true);
    expect(isWithinAvailability([slot], monday('16:30'), 60)).toBe(false);
    expect(isWithinAvailability([slot], monday('08:30'), 60)).toBe(false);
    expect(
      isWithinAvailability([slot], new Date('2030-01-08T10:00:00Z'), 60),
    ).toBe(false);
  });

  it('rejects a job that runs past midnight', () => {
    const wide = { dayOfWeek: 1, startTime: '00:00:00', endTime: '23:59:00' };
    expect(isWithinAvailability([wide], monday('23:30'), 60)).toBe(false);
  });

  it('treats back-to-back bookings as non-overlapping', () => {
    expect(overlaps(monday('10:00'), 60, monday('11:00'), 60)).toBe(false);
    expect(overlaps(monday('10:00'), 60, monday('10:30'), 60)).toBe(true);
  });

  it('rejects dates in the past', () => {
    expect(() => assertInFuture(new Date('2000-01-01T00:00:00Z'))).toThrow(
      BadRequestException,
    );
    expect(() => assertInFuture(new Date('2999-01-01T00:00:00Z'))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/booking/eligibility.spec.ts`
Expected: FAIL — cannot find module `./eligibility`.

- [ ] **Step 3: Implement the helpers**

`src/booking/eligibility.ts`
```ts
import { BadRequestException } from '@nestjs/common';

export interface EligibilityContext {
  categoryId: string;
  postcode: string;
  scheduledAt: Date;
  durationMinutes: number;
  excludeBookingId?: string;
}

const normalisePostcode = (postcode: string) =>
  postcode.replace(/\s+/g, '').toUpperCase();

// 'HH:mm' or 'HH:mm:ss' -> minutes since midnight
const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

export function coversPostcode(coverage: string[], postcode: string): boolean {
  const wanted = normalisePostcode(postcode);
  return coverage.some((entry) => normalisePostcode(entry) === wanted);
}

// ponytail: compared in UTC (windows carry no timezone); per-provider timezone later
export function isWithinAvailability(
  slots: { dayOfWeek: number; startTime: string; endTime: string }[],
  start: Date,
  durationMinutes: number,
): boolean {
  const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMinutes = startMinutes + durationMinutes;
  if (endMinutes > 24 * 60) {
    return false;
  }
  return slots.some(
    (slot) =>
      slot.dayOfWeek === start.getUTCDay() &&
      toMinutes(slot.startTime) <= startMinutes &&
      endMinutes <= toMinutes(slot.endTime),
  );
}

export function overlaps(
  aStart: Date,
  aMinutes: number,
  bStart: Date,
  bMinutes: number,
): boolean {
  const aEnd = aStart.getTime() + aMinutes * 60_000;
  const bEnd = bStart.getTime() + bMinutes * 60_000;
  return aStart.getTime() < bEnd && bStart.getTime() < aEnd;
}

export function assertInFuture(date: Date): void {
  if (date.getTime() <= Date.now()) {
    throw new BadRequestException('Booking time must be in the future!');
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/booking/eligibility.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing service tests**

`src/booking/services/booking-plan.service.spec.ts`
```ts
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
  const providerRepo = { find: jest.fn(), findOne: jest.fn() };
  const subServiceRepo = { findOne: jest.fn() };
  const bookingRepo = { find: jest.fn() };
  const trustedRepo = { find: jest.fn() };
  const userRepo = { findOne: jest.fn() };

  const scheduledAt = new Date('2030-01-07T10:00:00Z'); // Monday
  const request = { subServiceId: 's1', scheduledAt };
  const makeProvider = (id: string, over: Partial<Provider> = {}) => ({
    id,
    userId: `u-${id}`,
    bio: 'bio',
    status: ProviderStatus.APPROVED,
    postcodeCoverage: ['SW1A 1AA'],
    categories: [{ id: 'cat1' }],
    availability: [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' }],
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
      makeProvider('wrong-category', { categories: [{ id: 'other' }] as never }),
      makeProvider('busy'),
      makeProvider('free'),
    ]);
    bookingRepo.find.mockImplementation(({ where }: { where: { providerId: string } }) =>
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
```

- [ ] **Step 6: Run to verify failure**

Run: `npx jest src/booking/services/booking-plan.service.spec.ts`
Expected: FAIL — cannot find module `./booking-plan.service`.

- [ ] **Step 7: DTO and service**

`src/booking/dto/plan-booking.dto.ts`
```ts
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class PlanBookingDto {
  @IsUUID()
  subServiceId: string;

  @Type(() => Date)
  @IsDate()
  scheduledAt: Date;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
```

`src/booking/services/booking-plan.service.ts`
```ts
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

  async planBooking(userId: string, data: PlanBookingDto): Promise<BookingPlan> {
    assertInFuture(data.scheduledAt);
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
```

- [ ] **Step 8: Controller (plan only for now) and module wiring**

`src/booking/booking.controller.ts`
```ts
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { Role } from '../user/enums/role.enum';
import { PlanBookingDto } from './dto/plan-booking.dto';
import { BookingPlanService } from './services/booking-plan.service';

@Controller('bookings')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class BookingController {
  constructor(private readonly bookingPlanService: BookingPlanService) {}

  @Post('/plan')
  @Roles(Role.CUSTOMER)
  async planBooking(
    @Req() req: AuthenticatedRequest,
    @Body() body: PlanBookingDto,
  ) {
    return this.bookingPlanService.planBooking(req.user.id, body);
  }
}
```

In `src/booking/booking.module.ts` add `controllers: [BookingController], providers: [BookingPlanService]` (with imports for both).

- [ ] **Step 9: Run tests, build, lint**

Run: `npx jest src/booking && npm run build && npm run lint`
Expected: all PASS, build clean, lint clean.

- [ ] **Step 10: Commit**

```bash
git add src/booking
git commit -m "Phase 4: eligibility helpers and POST /bookings/plan

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Booking lifecycle — confirm, transitions, edit, cancel, list, detail

**Files:**
- Create: `src/booking/dto/create-booking.dto.ts`, `src/booking/dto/update-booking.dto.ts`, `src/booking/dto/list-bookings-query.dto.ts`, `src/booking/services/booking.service.ts`, `src/booking/services/booking.service.spec.ts`
- Modify: `src/booking/booking.controller.ts`, `src/booking/booking.module.ts`

**Interfaces:**
- Consumes: `BookingPlanService.getSubService/getPostcode/assertEligible`, `assertInFuture`, `NotificationsService.notify`.
- Produces `BookingService`:
  - `createBooking(userId: string, data: CreateBookingDto): Promise<Booking>`
  - `acceptBooking(userId: string, id: string): Promise<Booking>`, `declineBooking`, `startBooking`, `completeBooking` (same signature; `userId` is the provider's *user* id)
  - `updateBooking(userId: string, id: string, data: UpdateBookingDto): Promise<Booking>`
  - `cancelBooking(userId: string, id: string): Promise<Booking>`
  - `listBookings(userId: string, role: Role, query: ListBookingsQueryDto): Promise<Booking[]>`
  - `getBooking(userId: string, role: Role, id: string)` → booking + `householdNotes` (assigned provider only)
  - `addTrustedProvider(userId: string, providerId: string): Promise<{ message: string }>` (added in Task 4)

- [ ] **Step 1: DTOs**

`src/booking/dto/create-booking.dto.ts`
```ts
import { IsUUID } from 'class-validator';
import { PlanBookingDto } from './plan-booking.dto';

export class CreateBookingDto extends PlanBookingDto {
  @IsUUID()
  providerId: string;
}
```

`src/booking/dto/update-booking.dto.ts`
```ts
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBookingDto {
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledAt?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
```

`src/booking/dto/list-bookings-query.dto.ts`
```ts
import { IsEnum, IsOptional } from 'class-validator';
import { BookingStatus } from '../enums/booking-status.enum';

export class ListBookingsQueryDto {
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;
}
```

- [ ] **Step 2: Write the failing tests**

`src/booking/services/booking.service.spec.ts`
```ts
import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
```

- [ ] **Step 3: Run to verify failure**

Run: `npx jest src/booking/services/booking.service.spec.ts`
Expected: FAIL — cannot find module `./booking.service`.

- [ ] **Step 4: Implement `BookingService`**

`src/booking/services/booking.service.ts`
```ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationsService } from '../../notifications/notifications.service';
import { Provider } from '../../provider/entities/provider.entity';
import { User } from '../../user/entities/user.entity';
import { Role } from '../../user/enums/role.enum';
import { CreateBookingDto } from '../dto/create-booking.dto';
import { ListBookingsQueryDto } from '../dto/list-bookings-query.dto';
import { UpdateBookingDto } from '../dto/update-booking.dto';
import { Booking } from '../entities/booking.entity';
import { TrustedProvider } from '../entities/trusted-provider.entity';
import { BookingStatus } from '../enums/booking-status.enum';
import { assertInFuture } from '../eligibility';
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

  async createBooking(userId: string, data: CreateBookingDto): Promise<Booking> {
    assertInFuture(data.scheduledAt);
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

    if (
      data.scheduledAt !== undefined &&
      data.scheduledAt.getTime() !== booking.scheduledAt.getTime()
    ) {
      assertInFuture(data.scheduledAt);
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
      booking.scheduledAt = data.scheduledAt;
      // the provider has to re-accept the new time
      booking.status = BookingStatus.PENDING_PROVIDER;
    }
    if (data.notes !== undefined) {
      booking.notes = data.notes;
    }

    const saved = await this.bookingRepository.save(booking);
    this.notificationsService.notify(booking.provider.userId, 'BOOKING_UPDATED', {
      bookingId: booking.id,
    });
    return saved;
  }

  async cancelBooking(userId: string, id: string): Promise<Booking> {
    const booking = await this.getOwnedBooking(userId, id);
    if (!EDITABLE_STATUSES.includes(booking.status)) {
      throw new ConflictException('Only upcoming bookings can be cancelled!');
    }
    booking.status = BookingStatus.CANCELLED;
    const saved = await this.bookingRepository.save(booking);
    this.notificationsService.notify(booking.provider.userId, 'BOOKING_CANCELLED', {
      bookingId: booking.id,
    });
    return saved;
  }

  async listBookings(
    userId: string,
    role: Role,
    query: ListBookingsQueryDto,
  ): Promise<Booking[]> {
    const owner =
      role === Role.PROVIDER
        ? { providerId: (await this.getProviderForUser(userId)).id }
        : { userId };
    return this.bookingRepository.find({
      where: { ...owner, ...(query.status ? { status: query.status } : {}) },
      relations: { subService: true },
      order: { scheduledAt: 'ASC' },
    });
  }

  async getBooking(userId: string, role: Role, id: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id },
      relations: { provider: true, subService: true },
    });
    const isOwner = booking?.userId === userId;
    const isAssignedProvider =
      role === Role.PROVIDER && booking?.provider.userId === userId;
    if (!booking || !(isOwner || isAssignedProvider || role === Role.ADMIN)) {
      throw new NotFoundException('Booking not found!');
    }

    // household notes go to the assigned provider only, read live (not copied onto the booking)
    let householdNotes: string | null | undefined;
    if (isAssignedProvider) {
      const customer = await this.userRepository.findOne({
        where: { id: booking.userId },
        select: { id: true, householdNotes: true },
      });
      householdNotes = customer?.householdNotes ?? null;
    }
    return { ...booking, householdNotes };
  }

  private async transitionAsProvider(
    userId: string,
    id: string,
    from: BookingStatus,
    to: BookingStatus,
    event: string,
  ): Promise<Booking> {
    const provider = await this.getProviderForUser(userId);
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
    booking.status = to;
    const saved = await this.bookingRepository.save(booking);
    this.notificationsService.notify(booking.userId, event, {
      bookingId: booking.id,
    });
    return saved;
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx jest src/booking/services/booking.service.spec.ts`
Expected: PASS (all tests). If `getBooking` typing of `householdNotes` complains in the spec, widen with the return type TS infers — do not cast.

- [ ] **Step 6: Extend the controller**

Replace `src/booking/booking.controller.ts` with:
```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { Role } from '../user/enums/role.enum';
import { CreateBookingDto } from './dto/create-booking.dto';
import { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import { PlanBookingDto } from './dto/plan-booking.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';
import { BookingPlanService } from './services/booking-plan.service';
import { BookingService } from './services/booking.service';

@Controller('bookings')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class BookingController {
  constructor(
    private readonly bookingService: BookingService,
    private readonly bookingPlanService: BookingPlanService,
  ) {}

  @Post('/plan')
  @Roles(Role.CUSTOMER)
  async planBooking(
    @Req() req: AuthenticatedRequest,
    @Body() body: PlanBookingDto,
  ) {
    return this.bookingPlanService.planBooking(req.user.id, body);
  }

  @Post()
  @Roles(Role.CUSTOMER)
  async createBooking(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateBookingDto,
  ) {
    return this.bookingService.createBooking(req.user.id, body);
  }

  @Get()
  @Roles(Role.CUSTOMER, Role.PROVIDER)
  async listBookings(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListBookingsQueryDto,
  ) {
    return this.bookingService.listBookings(req.user.id, req.user.role, query);
  }

  @Get('/:id')
  @Roles(Role.CUSTOMER, Role.PROVIDER, Role.ADMIN)
  async getBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.getBooking(req.user.id, req.user.role, id);
  }

  @Patch('/:id')
  @Roles(Role.CUSTOMER)
  async updateBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBookingDto,
  ) {
    return this.bookingService.updateBooking(req.user.id, id, body);
  }

  @Delete('/:id')
  @Roles(Role.CUSTOMER)
  async cancelBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.cancelBooking(req.user.id, id);
  }

  @Post('/:id/accept')
  @Roles(Role.PROVIDER)
  async acceptBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.acceptBooking(req.user.id, id);
  }

  @Post('/:id/decline')
  @Roles(Role.PROVIDER)
  async declineBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.declineBooking(req.user.id, id);
  }

  @Post('/:id/start')
  @Roles(Role.PROVIDER)
  async startBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.startBooking(req.user.id, id);
  }

  @Post('/:id/complete')
  @Roles(Role.PROVIDER)
  async completeBooking(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.completeBooking(req.user.id, id);
  }
}
```
Add `BookingService` to the module's `providers`.

- [ ] **Step 7: Test, build, lint, commit**

Run: `npx jest src/booking && npm run build && npm run lint`
Expected: PASS, clean.
```bash
git add src/booking
git commit -m "Phase 4: booking lifecycle (confirm, accept/decline/start/complete, edit, cancel, list, detail)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Trusted providers + admin bookings

**Files:**
- Create: `src/booking/dto/reassign-booking.dto.ts`, `src/booking/services/admin-booking.service.ts`, `src/booking/services/admin-booking.service.spec.ts`, `src/booking/trusted-provider.controller.ts`, `src/booking/admin-booking.controller.ts`
- Modify: `src/booking/services/booking.service.ts` (add `addTrustedProvider`), `src/booking/services/booking.service.spec.ts` (add tests), `src/booking/booking.module.ts`

**Interfaces:**
- Consumes: `BookingPlanService.getPostcode/assertEligible`, `ListBookingsQueryDto`.
- Produces: `BookingService.addTrustedProvider(userId, providerId)`; `AdminBookingService.listBookings(query: ListBookingsQueryDto): Promise<Booking[]>`, `AdminBookingService.reassignBooking(id: string, data: ReassignBookingDto): Promise<Booking>`.

- [ ] **Step 1: Add failing trusted-provider tests**

Append inside the top-level `describe` of `booking.service.spec.ts`:
```ts
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
```
and add `ForbiddenException` to the `@nestjs/common` import at the top.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/booking/services/booking.service.spec.ts -t addTrustedProvider`
Expected: FAIL — `service.addTrustedProvider is not a function`.

- [ ] **Step 3: Implement `addTrustedProvider`**

In `booking.service.ts` add `ForbiddenException` to the `@nestjs/common` import and, after `getBooking`:
```ts
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
```

- [ ] **Step 4: Controller for trusted providers**

`src/booking/trusted-provider.controller.ts`
```ts
import {
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { Role } from '../user/enums/role.enum';
import { BookingService } from './services/booking.service';

@Controller('user/trusted-providers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.CUSTOMER)
export class TrustedProviderController {
  constructor(private readonly bookingService: BookingService) {}

  @Post('/:providerId')
  async addTrustedProvider(
    @Req() req: AuthenticatedRequest,
    @Param('providerId', ParseUUIDPipe) providerId: string,
  ) {
    return this.bookingService.addTrustedProvider(req.user.id, providerId);
  }
}
```

- [ ] **Step 5: Write failing admin tests**

`src/booking/services/admin-booking.service.spec.ts`
```ts
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
    bookingRepo.findOne.mockResolvedValue(
      makeBooking(BookingStatus.CONFIRMED),
    );
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
```

- [ ] **Step 6: Run to verify failure**

Run: `npx jest src/booking/services/admin-booking.service.spec.ts`
Expected: FAIL — cannot find module `./admin-booking.service`.

- [ ] **Step 7: Implement admin DTO, service, controller**

`src/booking/dto/reassign-booking.dto.ts`
```ts
import { IsUUID } from 'class-validator';

export class ReassignBookingDto {
  @IsUUID()
  providerId: string;
}
```

`src/booking/services/admin-booking.service.ts`
```ts
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
```

`src/booking/admin-booking.controller.ts`
```ts
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from '../user/enums/role.enum';
import { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import { ReassignBookingDto } from './dto/reassign-booking.dto';
import { AdminBookingService } from './services/admin-booking.service';

@Controller('admin/bookings')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN)
export class AdminBookingController {
  constructor(private readonly adminBookingService: AdminBookingService) {}

  @Get()
  async listBookings(@Query() query: ListBookingsQueryDto) {
    return this.adminBookingService.listBookings(query);
  }

  @Post('/:id/reassign')
  async reassignBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReassignBookingDto,
  ) {
    return this.adminBookingService.reassignBooking(id, body);
  }
}
```

Final `src/booking/booking.module.ts`: `controllers: [BookingController, TrustedProviderController, AdminBookingController]`, `providers: [BookingPlanService, BookingService, AdminBookingService]`.

- [ ] **Step 8: Full test, build, lint, commit**

Run: `npm test && npm run build && npm run lint`
Expected: all suites PASS (previous 25 tests + new), build and lint clean.
```bash
git add src/booking
git commit -m "Phase 4: trusted providers and admin booking list/reassign

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Live verification and documentation

**Files:**
- Create: `PHASE_4_MODULE_GUIDE.md`, `PHASE_4_API.md`
- Modify: `postman/Handy-AI.postman_collection.json`, `CLAUDE.md`, `PLAN.md`

- [ ] **Step 1: Boot the app against real Postgres+Redis**

```bash
docker compose ps   # redis must be up
PORT=3100 npm run start &   # 3000/3001 are taken on this machine
curl -s localhost:3100/api/v1/health
```
Expected: 200 health response.

- [ ] **Step 2: Walk the flow with curl (record the actual responses)**

Create via the API: a CUSTOMER (sign up, verify OTP, set `postcode` via `PATCH /user/profile`), a PROVIDER (onboard with category + `postcodeCoverage` containing the customer's postcode + a Monday-style availability window covering the test time, upload docs or insert `APPROVED` status and docs directly in the DB the way Phase 3 verification did), and use `admin@admin.com` to approve. Then verify each, noting HTTP status:
1. `POST /bookings/plan` → 201 plan; customer with no postcode → 400; past date → 400; far-away postcode → 404.
2. `POST /bookings` → `PENDING_PROVIDER`; the same slot again → 409.
3. Provider `GET /bookings` shows it; `accept` → `CONFIRMED`; `complete` straight away → 409; `start` → `IN_PROGRESS`; `complete` → `COMPLETED`.
4. Customer `POST /user/trusted-providers/:providerId` → 201; before completion → 403. Re-plan the same service: `isTrustedProvider: true`.
5. `PATCH` notes only keeps status; `PATCH` time resets to `PENDING_PROVIDER`; `DELETE` → `CANCELLED`; `DELETE` on `IN_PROGRESS` → 409.
6. Provider `GET /bookings/:id` includes `householdNotes`; customer's does not; a third user → 404.
7. Admin `GET /admin/bookings`, `POST /admin/bookings/:id/reassign` to a second eligible provider → `PENDING_PROVIDER`, new `providerId`.

Kill the app and delete all test users/bookings/providers created (as in Phase 3). Any bug found → fix with a failing test first, commit separately.

- [ ] **Step 3: Write docs**

- `PHASE_4_API.md`: every endpoint, role, request body, response shape, status codes, the state diagram (from the spec).
- `PHASE_4_MODULE_GUIDE.md`: module layout, where the AI swap-in goes (`BookingPlanService.planBooking`), the two known shortcuts (UTC availability, check-then-insert), the provider-delete FK gap, the stale-relation gotcha.
- Postman: add a "Booking" folder (plan, create, list, detail, edit, cancel, accept/decline/start/complete, trusted provider) and an "Admin → Bookings" pair; follow the style of the existing Provider/Admin folders.
- `CLAUDE.md`: Phase 4 row → `Done`; add a dated decision-log entry (decisions: `providerId` non-null, `PLAN_PROPOSED` dropped, `start` endpoint added, household notes read live, UTC availability, log-only `NotificationsService` exists now).
- `PLAN.md`: mark Phase 4 done with deviations, as Phases 2–3 do.

- [ ] **Step 4: Final checks and commit**

Run: `npm test && npm run build && npm run lint`
Expected: PASS and clean.
```bash
git add PHASE_4_MODULE_GUIDE.md PHASE_4_API.md postman CLAUDE.md PLAN.md
git commit -m "Document Phase 4: module guide, API reference, Postman folders, context updates

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
