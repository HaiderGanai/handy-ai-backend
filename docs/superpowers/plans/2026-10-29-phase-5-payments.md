# Phase 5 — Payments (Stripe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers pay (card authorised and held) when a booking is created; on job completion the payment is captured and 80% is transferred to the provider's Stripe Express account (held until they connect one), 20% kept by the platform.

**Architecture:** New `src/payments/` module. `StripeService` is the only file that touches the Stripe SDK (the mock boundary for all tests). `PaymentsService` holds money logic (checkout, hold release, capture + payout, receipts/earnings). `StripeWebhookService` turns Stripe events into booking/transaction changes. `BookingService` calls `PaymentsService` at create/cancel/decline/complete. Separate charges and transfers (not destination charges): capture lands on the platform account, then a Transfer pays the provider.

**Tech Stack:** NestJS 11, TypeORM 0.3, Postgres, Jest, `stripe` Node SDK (CommonJS build).

**Spec:** `docs/superpowers/specs/2026-10-29-phase-5-payments-design.md` (binding authority; read it first).

## Global Constraints

- Follow `GUIDE.md`: controller method name == service method name, Nest built-in exceptions with messages ending `!`, no try/catch in controllers, DTO/entity merges check `!== undefined` per field.
- Money is integer **USD cents**. Commission = `Math.floor(amount * 20 / 100)`; payout = `amount - commission`.
- The Stripe SDK is imported **only** in `src/payments/stripe.service.ts`. Everything else mocks `StripeService`.
- `.env` `DATABASE_URL` points at the **server** DB. Never run migrations, seeds or `migration:*` against it in this plan. Local runs use the commented local URL (shown in Task 2). Applying to the server is the user's decision at the end.
- Unit tests must not print noise: spy `Logger.prototype.error` where code logs errors.
- Commit trailer on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Stripe SDK type errors during implementation are resolved against the installed SDK's types **without changing behaviour** (parameter names below follow the stable Stripe API).

## Review Focus

1. A payment landing on a booking that was cancelled or expired meanwhile → its PaymentIntent is cancelled, no `Transaction` (Task 5).
2. Webhook redelivery (same event twice) → no duplicate transaction, no second provider notification (Task 5).
3. Providers never see or act on `PENDING_PAYMENT` bookings — list, detail, accept/decline/start/complete (Task 6).
4. Capture succeeded but Transfer failed → booking still completes, transaction stays `CAPTURED`; retrying `complete`/`account.updated` never captures twice (Task 4).
5. Bookings created before payments existed (no `Transaction`) still complete normally (Task 4).
6. A job at the very end of the 7-day horizon may finish after the card hold lapsed (known edge, spec-approved; mention at hand-off).

## File Structure

```
src/payments/
  enums/transaction-status.enum.ts      HELD | CAPTURED | RELEASED | CANCELLED
  entities/transaction.entity.ts
  dto/list-transactions-query.dto.ts
  money.ts (+ .spec.ts)                 splitAmount
  stripe.service.ts (+ .spec.ts)        SDK wrapper, isPayoutReady, webhook signature check
  payments.service.ts (+ .spec.ts)      checkout, hold release, capture+payout, connect, earnings, receipts, admin list
  stripe-webhook.service.ts (+ .spec.ts)
  stripe-webhook.controller.ts          POST /webhooks/stripe (no auth guard)
  payments.controller.ts                provider/stripe-account, provider/earnings, user/receipts, admin/transactions
  payments.module.ts
src/database/migrations/<ts>-Phase5Payments.ts
modified: booking enum/service/controller/module, eligibility.ts, user+provider entities, main.ts, app.module.ts,
          demo seed, .env.example, docs, Postman, PLAN.md, CLAUDE.md
```

---

### Task 1: Stripe SDK, money maths, `StripeService`

**Files:**
- Create: `src/payments/money.ts`, `src/payments/money.spec.ts`, `src/payments/stripe.service.ts`, `src/payments/stripe.service.spec.ts`
- Modify: `package.json` (dependency), `.env.example`

**Interfaces:**
- Produces: `splitAmount(amountCents: number): { commissionCents: number; providerPayoutCents: number }`
- Produces: `isPayoutReady(account): boolean`
- Produces `StripeService` methods: `createCustomer(email: string, userId: string): Promise<string>`; `createCheckoutSession(p: { customerId: string; amountCents: number; productName: string; bookingId: string }): Promise<{ url: string }>`; `cancelPaymentIntent(id: string): Promise<void>`; `capturePaymentIntent(id: string): Promise<{ chargeId: string }>`; `createTransfer(p: { amountCents: number; destination: string; chargeId: string; bookingId: string; idempotencyKey: string }): Promise<string>`; `createConnectedAccount(email: string, providerId: string): Promise<string>`; `createAccountLink(accountId: string): Promise<string>`; `constructEvent(rawBody: Buffer, signature: string): Stripe.Event`.

- [ ] **Step 1: Install the SDK and prove it loads under Jest/CommonJS**

Run: `npm install stripe && node -e "console.log(require('stripe/package.json').version)"`
Expected: a version prints. (Lesson from CLAUDE.md: verify new packages are unit-testable here before building on them. The real check is Step 3.)

- [ ] **Step 2: Write the failing money test** — `src/payments/money.spec.ts`

```ts
import { splitAmount } from './money';

describe('splitAmount', () => {
  it('takes 20% commission and pays the rest to the provider', () => {
    expect(splitAmount(8000)).toEqual({
      commissionCents: 1600,
      providerPayoutCents: 6400,
    });
  });

  it('rounds the commission down so the two parts always add up exactly', () => {
    const { commissionCents, providerPayoutCents } = splitAmount(999);
    expect(commissionCents).toBe(199);
    expect(providerPayoutCents).toBe(800);
    expect(commissionCents + providerPayoutCents).toBe(999);
  });
});
```

Run: `npx jest src/payments/money.spec.ts` — Expected: FAIL (cannot find module `./money`).

- [ ] **Step 3: Implement money** — `src/payments/money.ts`

```ts
export const COMMISSION_PERCENT = 20;

// integer cents only; the commission rounds down so commission + payout === amount
export function splitAmount(amountCents: number): {
  commissionCents: number;
  providerPayoutCents: number;
} {
  const commissionCents = Math.floor((amountCents * COMMISSION_PERCENT) / 100);
  return { commissionCents, providerPayoutCents: amountCents - commissionCents };
}
```

Run: `npx jest src/payments/money.spec.ts` — Expected: PASS.

- [ ] **Step 4: Write the failing StripeService test** — `src/payments/stripe.service.spec.ts` (uses the real SDK offline for signature checking, which also proves the package loads under Jest)

```ts
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { isPayoutReady, StripeService } from './stripe.service';

const SECRET = 'whsec_test_secret';
const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('StripeService', () => {
  const payload = JSON.stringify({
    id: 'evt_1',
    object: 'event',
    type: 'account.updated',
    data: { object: { id: 'acct_1' } },
  });
  const sign = (secret = SECRET) =>
    new Stripe('sk_test_unused').webhooks.generateTestHeaderString({
      payload,
      secret,
    });

  it('accepts a correctly signed webhook payload', () => {
    const service = new StripeService(config({ STRIPE_WEBHOOK_SECRET: SECRET }));
    const event = service.constructEvent(Buffer.from(payload), sign());
    expect(event.type).toBe('account.updated');
  });

  it('rejects a payload signed with another secret with 400', () => {
    const service = new StripeService(config({ STRIPE_WEBHOOK_SECRET: SECRET }));
    expect(() =>
      service.constructEvent(Buffer.from(payload), sign('whsec_other')),
    ).toThrow(BadRequestException);
  });

  it('answers 503 when the webhook secret is not configured', () => {
    const service = new StripeService(config({}));
    expect(() => service.constructEvent(Buffer.from(payload), sign())).toThrow(
      ServiceUnavailableException,
    );
  });

  it('answers 503 on API calls when the secret key is not configured', async () => {
    const service = new StripeService(config({}));
    await expect(service.cancelPaymentIntent('pi_1')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('isPayoutReady', () => {
  it('needs payouts enabled and the transfers capability active', () => {
    expect(
      isPayoutReady({ payouts_enabled: true, capabilities: { transfers: 'active' } }),
    ).toBe(true);
    expect(
      isPayoutReady({ payouts_enabled: true, capabilities: { transfers: 'pending' } }),
    ).toBe(false);
    expect(isPayoutReady({ payouts_enabled: false, capabilities: { transfers: 'active' } })).toBe(false);
    expect(isPayoutReady({ payouts_enabled: true })).toBe(false);
  });
});
```

Run: `npx jest src/payments/stripe.service.spec.ts`
Expected: FAIL (cannot find module `./stripe.service`). If instead the failure is an import/ESM error from `stripe` itself, STOP: pin the previous SDK major (`npm install stripe@<previous-major>`) until it loads, and record a `Ruling:` in the ledger.

- [ ] **Step 5: Implement `StripeService`** — `src/payments/stripe.service.ts`

```ts
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

// payouts need the account's payouts switched on and the `transfers` capability active
export function isPayoutReady(
  account: Pick<Stripe.Account, 'payouts_enabled' | 'capabilities'>,
): boolean {
  return (
    account.payouts_enabled === true &&
    account.capabilities?.transfers === 'active'
  );
}

// The only file that talks to Stripe. Everything else mocks this class in tests.
@Injectable()
export class StripeService {
  private stripe?: Stripe;

  constructor(private readonly config: ConfigService) {}

  async createCustomer(email: string, userId: string): Promise<string> {
    const customer = await this.client().customers.create({
      email,
      metadata: { userId },
    });
    return customer.id;
  }

  // card is authorised only (capture_method manual) and saved for the customer's next booking
  async createCheckoutSession(p: {
    customerId: string;
    amountCents: number;
    productName: string;
    bookingId: string;
  }): Promise<{ url: string }> {
    const session = await this.client().checkout.sessions.create({
      mode: 'payment',
      customer: p.customerId,
      client_reference_id: p.bookingId,
      // Stripe's minimum is 30 minutes from now
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: this.required('STRIPE_SUCCESS_URL'),
      cancel_url: this.required('STRIPE_CANCEL_URL'),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: p.amountCents,
            product_data: { name: p.productName },
          },
        },
      ],
      payment_intent_data: {
        capture_method: 'manual',
        setup_future_usage: 'off_session',
        transfer_group: `booking_${p.bookingId}`,
        metadata: { bookingId: p.bookingId },
      },
    });
    if (!session.url) {
      throw new Error('Stripe returned a Checkout Session without a url');
    }
    return { url: session.url };
  }

  async cancelPaymentIntent(id: string): Promise<void> {
    await this.client().paymentIntents.cancel(id);
  }

  async capturePaymentIntent(id: string): Promise<{ chargeId: string }> {
    const intent = await this.client().paymentIntents.capture(id);
    const charge = intent.latest_charge;
    const chargeId = typeof charge === 'string' ? charge : charge?.id;
    if (!chargeId) {
      throw new Error(`PaymentIntent ${id} was captured without a charge`);
    }
    return { chargeId };
  }

  // source_transaction ties the payout to the captured charge, so it works
  // before those funds reach the platform's available balance
  async createTransfer(p: {
    amountCents: number;
    destination: string;
    chargeId: string;
    bookingId: string;
    idempotencyKey: string;
  }): Promise<string> {
    const transfer = await this.client().transfers.create(
      {
        amount: p.amountCents,
        currency: 'usd',
        destination: p.destination,
        source_transaction: p.chargeId,
        transfer_group: `booking_${p.bookingId}`,
        metadata: { bookingId: p.bookingId },
      },
      { idempotencyKey: p.idempotencyKey },
    );
    return transfer.id;
  }

  async createConnectedAccount(
    email: string,
    providerId: string,
  ): Promise<string> {
    const account = await this.client().accounts.create({
      type: 'express',
      country: 'US',
      email,
      capabilities: { transfers: { requested: true } },
      metadata: { providerId },
    });
    return account.id;
  }

  async createAccountLink(accountId: string): Promise<string> {
    const link = await this.client().accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: this.required('STRIPE_CANCEL_URL'),
      return_url: this.required('STRIPE_SUCCESS_URL'),
    });
    return link.url;
  }

  // verifying a signature needs no API key, so any placeholder key will do
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const secret = this.required('STRIPE_WEBHOOK_SECRET');
    try {
      return new Stripe('sk_test_unused').webhooks.constructEvent(
        rawBody,
        signature,
        secret,
      );
    } catch {
      throw new BadRequestException('Invalid Stripe signature!');
    }
  }

  private client(): Stripe {
    this.stripe ??= new Stripe(this.required('STRIPE_SECRET_KEY'));
    return this.stripe;
  }

  private required(name: string): string {
    const value = this.config.get<string>(name);
    if (!value) {
      throw new ServiceUnavailableException('Payments are not configured!');
    }
    return value;
  }
}
```

Run: `npx jest src/payments/stripe.service.spec.ts` — Expected: PASS (5 tests).

- [ ] **Step 6: `.env.example`** — append after `STRIPE_WEBHOOK_SECRET=`:

```
# where Stripe sends the customer/provider after Checkout / onboarding (frontend supplies real ones)
STRIPE_SUCCESS_URL=http://localhost:3000/payment/success
STRIPE_CANCEL_URL=http://localhost:3000/payment/cancel
```

- [ ] **Step 7: Commit**

```bash
npx eslint src/payments --fix && npx jest src/payments
git add package.json package-lock.json .env.example src/payments docs/superpowers/specs/2026-10-29-phase-5-payments-design.md docs/superpowers/plans/2026-10-29-phase-5-payments.md
git commit -m "Phase 5: add Stripe SDK wrapper and commission maths

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Data model and migration

**Files:**
- Create: `src/payments/enums/transaction-status.enum.ts`, `src/payments/entities/transaction.entity.ts`, `src/database/migrations/1793900000000-Phase5Payments.ts`
- Modify: `src/booking/enums/booking-status.enum.ts`, `src/user/entities/user.entity.ts`, `src/provider/entities/provider.entity.ts`

**Interfaces:**
- Produces: `TransactionStatus` enum; `Transaction` entity (fields below); `BookingStatus.PENDING_PAYMENT`; `User.stripeCustomerId: string | null` (`@Exclude()`); `Provider.stripeOnboarded: boolean`.

- [ ] **Step 1: Enum + entity**

`src/payments/enums/transaction-status.enum.ts`
```ts
export enum TransactionStatus {
  HELD = 'HELD', // card authorised, not yet captured
  CAPTURED = 'CAPTURED', // captured; provider payout still waiting
  RELEASED = 'RELEASED', // provider paid
  CANCELLED = 'CANCELLED', // hold released, nothing charged
}
```

`src/payments/entities/transaction.entity.ts`
```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Booking } from '../../booking/entities/booking.entity';
import { TransactionStatus } from '../enums/transaction-status.enum';

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  bookingId: string;

  @OneToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bookingId' })
  booking: Booking;

  @Column({ type: 'varchar' })
  stripeCheckoutSessionId: string;

  @Column({ type: 'varchar' })
  stripePaymentIntentId: string;

  // set at capture; the payout Transfer uses it as source_transaction
  @Column({ type: 'varchar', nullable: true })
  stripeChargeId: string | null;

  @Column({ type: 'int' })
  amountCents: number;

  @Column({ type: 'int' })
  commissionCents: number;

  @Column({ type: 'int' })
  providerPayoutCents: number;

  @Column({
    type: 'enum',
    enum: TransactionStatus,
    default: TransactionStatus.HELD,
  })
  status: TransactionStatus;

  @Column({ type: 'varchar', nullable: true })
  stripeTransferId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
```

- [ ] **Step 2: Booking status, user and provider columns**

`booking-status.enum.ts` — add `PENDING_PAYMENT = 'PENDING_PAYMENT',` as the **first** member, and add `BookingStatus.PENDING_PAYMENT` as the first entry of `ACTIVE_BOOKING_STATUSES` (it holds the slot while the customer pays), with comment `// customer has not paid yet; invisible to providers`.

`user.entity.ts` — add after `householdNotes`:
```ts
  @Exclude()
  @Column({ type: 'varchar', nullable: true })
  stripeCustomerId: string | null;
```

`provider.entity.ts` — add after `stripeAccountId`:
```ts
  // true once Stripe says payouts are enabled (account.updated webhook)
  @Column({ default: false })
  stripeOnboarded: boolean;
```

- [ ] **Step 3: Hand-written migration** — `src/database/migrations/1793900000000-Phase5Payments.ts`

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase5Payments1793900000000 implements MigrationInterface {
  name = 'Phase5Payments1793900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."bookings_status_enum" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT' BEFORE 'PENDING_PROVIDER'`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "stripeCustomerId" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "providers" ADD "stripeOnboarded" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_status_enum" AS ENUM('HELD', 'CAPTURED', 'RELEASED', 'CANCELLED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "transactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "bookingId" uuid NOT NULL, "stripeCheckoutSessionId" character varying NOT NULL, "stripePaymentIntentId" character varying NOT NULL, "stripeChargeId" character varying, "amountCents" integer NOT NULL, "commissionCents" integer NOT NULL, "providerPayoutCents" integer NOT NULL, "status" "public"."transactions_status_enum" NOT NULL DEFAULT 'HELD', "stripeTransferId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_transactions_bookingId" UNIQUE ("bookingId"), CONSTRAINT "PK_transactions_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "FK_transactions_bookingId" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "FK_transactions_bookingId"`,
    );
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_status_enum"`);
    await queryRunner.query(`ALTER TABLE "providers" DROP COLUMN "stripeOnboarded"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "stripeCustomerId"`);
    // ponytail: Postgres can't drop an enum value; the unused 'PENDING_PAYMENT' is harmless to leave
  }
}
```

- [ ] **Step 4: Run it on the LOCAL database only and prove entities match**

```bash
LOCAL_URL=$(grep '^#DATABASE_URL=' .env | cut -d= -f2-)
echo "target: ${LOCAL_URL#*@}"        # must print localhost:5432/HandyAi — if it does not, STOP
DATABASE_URL="$LOCAL_URL" npm run migration:run
DATABASE_URL="$LOCAL_URL" npm run migration:generate -- src/database/migrations/ShouldBeEmpty
```
Expected: migration `Phase5Payments1793900000000` executed; the generate command prints "No changes in database schema were found" (entities and migration agree). If it generated a file, delete that file, fix the migration/entity mismatch, and re-run (revert first with `DATABASE_URL="$LOCAL_URL" npm run migration:revert`).

- [ ] **Step 5: Verify and commit**

Run: `npm run build && npx jest` — Expected: build clean, all suites still pass.
```bash
git add src/payments src/booking/enums src/user/entities src/provider/entities src/database/migrations
git commit -m "Phase 5: transactions table, PENDING_PAYMENT status, Stripe ids on user/provider

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 7-day booking horizon

**Files:**
- Modify: `src/booking/eligibility.ts`, `src/booking/eligibility.spec.ts`, `src/booking/services/booking-plan.service.ts`, `src/booking/services/booking.service.ts`, `src/booking/services/booking-plan.service.spec.ts`, `src/booking/services/booking.service.spec.ts`

**Interfaces:**
- Produces: `assertWithinHorizon(date: Date): void` (400 `Bookings can be made up to 7 days ahead!`), `BOOKING_HORIZON_DAYS = 7`. Called by `planBooking`, `createBooking`, and the time-change branch of `updateBooking`.

- [ ] **Step 1: Failing eligibility test** — add to `eligibility.spec.ts` (import `assertWithinHorizon`; `BadRequestException` is likely already imported):

```ts
describe('assertWithinHorizon', () => {
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

  it('allows a time inside 7 days', () => {
    expect(() => assertWithinHorizon(inDays(6))).not.toThrow();
  });

  it('rejects a time more than 7 days away with 400', () => {
    expect(() => assertWithinHorizon(inDays(8))).toThrow(BadRequestException);
  });
});
```
Run: `npx jest src/booking/eligibility.spec.ts` — Expected: FAIL (`assertWithinHorizon` is not exported).

- [ ] **Step 2: Implement** — append to `eligibility.ts`

```ts
// card holds expire after 7 days, so a booking can't be further out than that
// ponytail: a job on the very last day can finish after the hold lapsed; shrink the horizon if that bites
export const BOOKING_HORIZON_DAYS = 7;

export function assertWithinHorizon(date: Date): void {
  if (date.getTime() > Date.now() + BOOKING_HORIZON_DAYS * 86_400_000) {
    throw new BadRequestException(
      `Bookings can be made up to ${BOOKING_HORIZON_DAYS} days ahead!`,
    );
  }
}
```
Run the spec — Expected: PASS.

- [ ] **Step 3: Freeze "now" in the two booking specs and add the failing service tests**

Both `booking-plan.service.spec.ts` and `booking.service.spec.ts` use dates in the year 2999. Make "now" 2998-12-30 so those dates sit inside the horizon. At the top of each file's outer `describe(...)` callback add:

```ts
  beforeAll(() => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2998-12-30T00:00:00Z').getTime());
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });
```
Add failing tests:

`booking-plan.service.spec.ts` (inside the `planBooking` describe; reuse that file's existing setup/helpers for a customer with a postcode):
```ts
    it('rejects a time more than 7 days ahead', async () => {
      await expect(
        service.planBooking('c1', {
          subServiceId: 's1',
          scheduledAt: new Date('2999-02-01T10:00:00Z'),
        }),
      ).rejects.toThrow(BadRequestException);
    });
```
`booking.service.spec.ts` inside `describe('createBooking')`:
```ts
    it('rejects a time more than 7 days ahead without saving', async () => {
      await expect(
        service.createBooking('c1', { ...data, scheduledAt: new Date('2999-02-01T10:00:00Z') }),
      ).rejects.toThrow(BadRequestException);
      expect(bookingRepo.save).not.toHaveBeenCalled();
    });
```
and inside the `updateBooking` describe:
```ts
    it('rejects moving a booking more than 7 days ahead', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      await expect(
        service.updateBooking('c1', 'b1', { scheduledAt: new Date('2999-02-01T10:00:00Z') }),
      ).rejects.toThrow(BadRequestException);
      expect(bookingRepo.update).not.toHaveBeenCalled();
    });
```
Add `BadRequestException` to each file's `@nestjs/common` import if missing.
Run both specs — Expected: the three new tests FAIL (no rejection yet); all other tests pass.

- [ ] **Step 4: Wire the check** — import `assertWithinHorizon` next to `assertInFuture` and add the call straight after each `assertInFuture(...)` call: in `planBooking` (`booking-plan.service.ts`), in `createBooking`, and in the time-change branch of `updateBooking` (`booking.service.ts`, after `assertInFuture(data.scheduledAt)`).

Run: `npx jest src/booking` — Expected: all PASS. If an existing test uses a date more than 7 days after 2998-12-30 (anything after 2999-01-06), move that date inside the window.

- [ ] **Step 5: Commit**

```bash
npx eslint src/booking --fix
git add src/booking
git commit -m "Phase 5: limit bookings to 7 days ahead (card hold window)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `PaymentsService` — checkout, hold release, capture and payout

**Files:**
- Create: `src/payments/payments.service.ts`, `src/payments/payments.service.spec.ts`, `src/payments/payments.module.ts`

**Interfaces:**
- Consumes: `StripeService` (Task 1), `Transaction`/`TransactionStatus` (Task 2), `Booking`, `Provider`, `User` repositories.
- Produces on `PaymentsService`:
  - `createCheckout(booking: Pick<Booking,'id'|'userId'|'priceCents'>, productName: string): Promise<string>` (checkout url)
  - `releaseHold(bookingId: string): Promise<void>` (never throws on Stripe failure)
  - `captureAndPayout(booking: Pick<Booking,'id'|'providerId'>): Promise<void>` (throws 502 on capture failure; transfer failure is logged)
  - `payoutWaiting(providerId: string): Promise<void>`
  - `cancelUnclaimedHold(paymentIntentId: string): Promise<void>`
- Produces `PaymentsModule` (exports `PaymentsService`); more members arrive in Task 7.

- [ ] **Step 1: Write the failing spec** — `src/payments/payments.service.spec.ts`

```ts
import { BadGatewayException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Provider } from '../provider/entities/provider.entity';
import { User } from '../user/entities/user.entity';
import { Transaction } from './entities/transaction.entity';
import { TransactionStatus } from './enums/transaction-status.enum';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';

describe('PaymentsService', () => {
  let service: PaymentsService;
  const txRepo = { findOne: jest.fn(), find: jest.fn(), update: jest.fn() };
  const providerRepo = { findOne: jest.fn(), update: jest.fn() };
  const userRepo = { findOne: jest.fn(), update: jest.fn() };
  const stripe = {
    createCustomer: jest.fn(),
    createCheckoutSession: jest.fn(),
    cancelPaymentIntent: jest.fn(),
    capturePaymentIntent: jest.fn(),
    createTransfer: jest.fn(),
    createConnectedAccount: jest.fn(),
    createAccountLink: jest.fn(),
  };

  const makeTx = (over: object = {}) => ({
    id: 't1',
    bookingId: 'b1',
    stripePaymentIntentId: 'pi_1',
    stripeChargeId: null,
    amountCents: 8000,
    providerPayoutCents: 6400,
    status: TransactionStatus.HELD,
    ...over,
  });
  const connected = { id: 'p1', stripeAccountId: 'acct_1', stripeOnboarded: true };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    txRepo.update.mockResolvedValue({ affected: 1 });
    providerRepo.findOne.mockResolvedValue(connected);
    stripe.capturePaymentIntent.mockResolvedValue({ chargeId: 'ch_1' });
    stripe.createTransfer.mockResolvedValue('tr_1');
    const module = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Transaction), useValue: txRepo },
        { provide: getRepositoryToken(Provider), useValue: providerRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: StripeService, useValue: stripe },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  describe('createCheckout', () => {
    const booking = { id: 'b1', userId: 'c1', priceCents: 8000 };

    it('creates the Stripe customer once, stores it and returns the checkout url', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'c1', email: 'a@b.c', stripeCustomerId: null });
      stripe.createCustomer.mockResolvedValue('cus_1');
      stripe.createCheckoutSession.mockResolvedValue({ url: 'https://pay.test/s1' });

      const url = await service.createCheckout(booking, 'Regular home clean');

      expect(url).toBe('https://pay.test/s1');
      expect(userRepo.update).toHaveBeenCalledWith('c1', { stripeCustomerId: 'cus_1' });
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith({
        customerId: 'cus_1',
        amountCents: 8000,
        productName: 'Regular home clean',
        bookingId: 'b1',
      });
    });

    it('reuses an existing Stripe customer', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'c1', email: 'a@b.c', stripeCustomerId: 'cus_old' });
      stripe.createCheckoutSession.mockResolvedValue({ url: 'https://pay.test/s2' });
      await service.createCheckout(booking, 'Clean');
      expect(stripe.createCustomer).not.toHaveBeenCalled();
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 'cus_old' }),
      );
    });

    it('answers 502 when Stripe fails', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'c1', email: 'a@b.c', stripeCustomerId: 'cus_old' });
      stripe.createCheckoutSession.mockRejectedValue(new Error('stripe down'));
      await expect(service.createCheckout(booking, 'Clean')).rejects.toThrow(BadGatewayException);
    });
  });

  describe('releaseHold', () => {
    it('cancels the PaymentIntent and marks the transaction CANCELLED', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      await service.releaseHold('b1');
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_1');
      expect(txRepo.update).toHaveBeenCalledWith(
        { id: 't1', status: TransactionStatus.HELD },
        { status: TransactionStatus.CANCELLED },
      );
    });

    it('does nothing without a held transaction', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await service.releaseHold('b1');
      txRepo.findOne.mockResolvedValue(makeTx({ status: TransactionStatus.CAPTURED }));
      await service.releaseHold('b1');
      expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('swallows a Stripe failure and leaves the transaction HELD', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      stripe.cancelPaymentIntent.mockRejectedValue(new Error('stripe down'));
      await expect(service.releaseHold('b1')).resolves.toBeUndefined();
      expect(txRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('captureAndPayout', () => {
    const booking = { id: 'b1', providerId: 'p1' };

    it('skips bookings that have no transaction (created before payments existed)', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await service.captureAndPayout(booking);
      expect(stripe.capturePaymentIntent).not.toHaveBeenCalled();
    });

    it('captures, then pays 80% to a connected provider and marks RELEASED', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      await service.captureAndPayout(booking);
      expect(stripe.capturePaymentIntent).toHaveBeenCalledWith('pi_1');
      expect(txRepo.update).toHaveBeenNthCalledWith(1, 't1', {
        status: TransactionStatus.CAPTURED,
        stripeChargeId: 'ch_1',
      });
      expect(stripe.createTransfer).toHaveBeenCalledWith({
        amountCents: 6400,
        destination: 'acct_1',
        chargeId: 'ch_1',
        bookingId: 'b1',
        idempotencyKey: 'payout-t1',
      });
      expect(txRepo.update).toHaveBeenNthCalledWith(2, 't1', {
        status: TransactionStatus.RELEASED,
        stripeTransferId: 'tr_1',
      });
    });

    it('captures but keeps the money when the provider has not connected Stripe', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      providerRepo.findOne.mockResolvedValue({ id: 'p1', stripeAccountId: null, stripeOnboarded: false });
      await service.captureAndPayout(booking);
      expect(stripe.capturePaymentIntent).toHaveBeenCalled();
      expect(stripe.createTransfer).not.toHaveBeenCalled();
      expect(txRepo.update).toHaveBeenCalledTimes(1);
    });

    it('answers 502 and changes nothing when the capture fails', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      stripe.capturePaymentIntent.mockRejectedValue(new Error('card declined'));
      await expect(service.captureAndPayout(booking)).rejects.toThrow(BadGatewayException);
      expect(txRepo.update).not.toHaveBeenCalled();
    });

    it('keeps the transaction CAPTURED when only the transfer fails', async () => {
      txRepo.findOne.mockResolvedValue(makeTx());
      stripe.createTransfer.mockRejectedValue(new Error('transfer failed'));
      await expect(service.captureAndPayout(booking)).resolves.toBeUndefined();
      expect(txRepo.update).toHaveBeenCalledTimes(1); // the CAPTURED write only
    });

    it('never captures twice: a retry on a CAPTURED transaction only pays out', async () => {
      txRepo.findOne.mockResolvedValue(
        makeTx({ status: TransactionStatus.CAPTURED, stripeChargeId: 'ch_1' }),
      );
      await service.captureAndPayout(booking);
      expect(stripe.capturePaymentIntent).not.toHaveBeenCalled();
      expect(stripe.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ chargeId: 'ch_1' }),
      );
    });
  });

  describe('payoutWaiting', () => {
    it('pays out every CAPTURED transaction of the provider', async () => {
      txRepo.find.mockResolvedValue([
        makeTx({ id: 't1', status: TransactionStatus.CAPTURED, stripeChargeId: 'ch_1' }),
        makeTx({ id: 't2', bookingId: 'b2', status: TransactionStatus.CAPTURED, stripeChargeId: 'ch_2' }),
      ]);
      await service.payoutWaiting('p1');
      expect(stripe.createTransfer).toHaveBeenCalledTimes(2);
      expect(txRepo.update).toHaveBeenCalledWith('t2', {
        status: TransactionStatus.RELEASED,
        stripeTransferId: 'tr_1',
      });
    });

    it('does nothing while the provider is not connected', async () => {
      txRepo.find.mockResolvedValue([
        makeTx({ status: TransactionStatus.CAPTURED, stripeChargeId: 'ch_1' }),
      ]);
      providerRepo.findOne.mockResolvedValue({ id: 'p1', stripeAccountId: null, stripeOnboarded: false });
      await service.payoutWaiting('p1');
      expect(stripe.createTransfer).not.toHaveBeenCalled();
    });
  });

  describe('cancelUnclaimedHold', () => {
    it('cancels the PaymentIntent', async () => {
      await service.cancelUnclaimedHold('pi_9');
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_9');
    });
  });
});
```

Run: `npx jest src/payments/payments.service.spec.ts` — Expected: FAIL (cannot find module `./payments.service`).

- [ ] **Step 2: Implement** — `src/payments/payments.service.ts`

```ts
import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking } from '../booking/entities/booking.entity';
import { Provider } from '../provider/entities/provider.entity';
import { User } from '../user/entities/user.entity';
import { Transaction } from './entities/transaction.entity';
import { TransactionStatus } from './enums/transaction-status.enum';
import { StripeService } from './stripe.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Provider)
    private readonly providerRepository: Repository<Provider>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly stripeService: StripeService,
  ) {}

  async createCheckout(
    booking: Pick<Booking, 'id' | 'userId' | 'priceCents'>,
    productName: string,
  ): Promise<string> {
    const customerId = await this.getStripeCustomerId(booking.userId);
    const session = await this.stripeCall(() =>
      this.stripeService.createCheckoutSession({
        customerId,
        amountCents: booking.priceCents,
        productName,
        bookingId: booking.id,
      }),
    );
    return session.url;
  }

  // Frees the customer's card hold. A Stripe failure is logged, not thrown: the booking
  // change stands, the transaction stays HELD for admin visibility and the hold lapses
  // by itself within 7 days.
  async releaseHold(bookingId: string): Promise<void> {
    const transaction = await this.transactionRepository.findOne({
      where: { bookingId },
    });
    if (!transaction || transaction.status !== TransactionStatus.HELD) {
      return;
    }
    try {
      await this.stripeService.cancelPaymentIntent(
        transaction.stripePaymentIntentId,
      );
    } catch (error) {
      this.logger.error(
        `Could not release hold for booking ${bookingId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return;
    }
    await this.transactionRepository.update(
      { id: transaction.id, status: TransactionStatus.HELD },
      { status: TransactionStatus.CANCELLED },
    );
  }

  // Money in on job completion. Capture failure -> 502 (booking stays IN_PROGRESS, provider
  // retries). Payout failure is logged: the money is safely captured and is retried by the
  // next account.updated webhook.
  async captureAndPayout(
    booking: Pick<Booking, 'id' | 'providerId'>,
  ): Promise<void> {
    const transaction = await this.transactionRepository.findOne({
      where: { bookingId: booking.id },
    });
    // bookings created before payments existed have nothing to capture
    if (!transaction) {
      return;
    }
    if (transaction.status === TransactionStatus.HELD) {
      const { chargeId } = await this.stripeCall(() =>
        this.stripeService.capturePaymentIntent(
          transaction.stripePaymentIntentId,
        ),
      );
      await this.transactionRepository.update(transaction.id, {
        status: TransactionStatus.CAPTURED,
        stripeChargeId: chargeId,
      });
      transaction.status = TransactionStatus.CAPTURED;
      transaction.stripeChargeId = chargeId;
    }
    if (transaction.status === TransactionStatus.CAPTURED) {
      await this.tryPayout(transaction, booking.providerId);
    }
  }

  // called when a provider finishes Stripe onboarding: pays everything that was waiting
  async payoutWaiting(providerId: string): Promise<void> {
    const waiting = await this.transactionRepository.find({
      where: {
        status: TransactionStatus.CAPTURED,
        booking: { providerId },
      },
    });
    for (const transaction of waiting) {
      await this.tryPayout(transaction, providerId);
    }
  }

  // a payment that landed on a booking that no longer needs it
  async cancelUnclaimedHold(paymentIntentId: string): Promise<void> {
    await this.stripeCall(() =>
      this.stripeService.cancelPaymentIntent(paymentIntentId),
    );
  }

  private async tryPayout(
    transaction: Transaction,
    providerId: string,
  ): Promise<void> {
    const provider = await this.providerRepository.findOne({
      where: { id: providerId },
    });
    if (!provider?.stripeAccountId || !provider.stripeOnboarded) {
      return;
    }
    try {
      const transferId = await this.stripeService.createTransfer({
        amountCents: transaction.providerPayoutCents,
        destination: provider.stripeAccountId,
        chargeId: transaction.stripeChargeId!,
        bookingId: transaction.bookingId,
        idempotencyKey: `payout-${transaction.id}`,
      });
      await this.transactionRepository.update(transaction.id, {
        status: TransactionStatus.RELEASED,
        stripeTransferId: transferId,
      });
    } catch (error) {
      this.logger.error(
        `Payout failed for transaction ${transaction.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async getStripeCustomerId(userId: string): Promise<string> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found!');
    }
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }
    const customerId = await this.stripeCall(() =>
      this.stripeService.createCustomer(user.email, user.id),
    );
    await this.userRepository.update(user.id, { stripeCustomerId: customerId });
    return customerId;
  }

  // Stripe/network failures become a clear 502; our own HTTP errors (e.g. "not configured") pass through
  private async stripeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(
        'Stripe call failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadGatewayException(
        'Payment service is unavailable, please retry!',
      );
    }
  }
}
```

- [ ] **Step 3: Module** — `src/payments/payments.module.ts` (grows in Tasks 5 and 7)

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../booking/entities/booking.entity';
import { Provider } from '../provider/entities/provider.entity';
import { User } from '../user/entities/user.entity';
import { Transaction } from './entities/transaction.entity';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction, Booking, Provider, User])],
  providers: [PaymentsService, StripeService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
```

- [ ] **Step 4: Run and commit**

Run: `npx jest src/payments` — Expected: all PASS, no logger noise.
```bash
npx eslint src/payments --fix
git add src/payments
git commit -m "Phase 5: PaymentsService (checkout, hold release, capture and payout)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Stripe webhook

**Files:**
- Create: `src/payments/stripe-webhook.service.ts`, `src/payments/stripe-webhook.service.spec.ts`, `src/payments/stripe-webhook.controller.ts`
- Modify: `src/payments/payments.module.ts`, `src/main.ts`, `src/booking/services/booking.service.ts` is NOT touched here

**Interfaces:**
- Consumes: `StripeService.constructEvent`, `PaymentsService.payoutWaiting` / `cancelUnclaimedHold`, `splitAmount`, `NotificationsService.notify(userId, event, payload)`.
- Produces: `StripeWebhookService.handleStripeWebhook(rawBody: Buffer, signature: string): Promise<{ received: true }>`; route `POST /api/v1/webhooks/stripe` (unauthenticated, signature-verified).

- [ ] **Step 1: Write the failing spec** — `src/payments/stripe-webhook.service.spec.ts`

```ts
import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type Stripe from 'stripe';
import { Booking } from '../booking/entities/booking.entity';
import { BookingStatus } from '../booking/enums/booking-status.enum';
import { NotificationsService } from '../notifications/notifications.service';
import { Provider } from '../provider/entities/provider.entity';
import { Transaction } from './entities/transaction.entity';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';
import { StripeWebhookService } from './stripe-webhook.service';

const event = (type: string, object: object) =>
  ({ type, data: { object } }) as unknown as Stripe.Event;

describe('StripeWebhookService', () => {
  let service: StripeWebhookService;
  const bookingRepo = { findOne: jest.fn(), update: jest.fn() };
  const txRepo = {
    findOne: jest.fn(),
    create: jest.fn((v: object) => v),
    save: jest.fn((v: object) => Promise.resolve(v)),
  };
  const providerRepo = { findOne: jest.fn(), update: jest.fn() };
  const stripe = { constructEvent: jest.fn() };
  const payments = { payoutWaiting: jest.fn(), cancelUnclaimedHold: jest.fn() };
  const notifications = { notify: jest.fn() };

  const session = {
    id: 'cs_1',
    client_reference_id: 'b1',
    payment_intent: 'pi_1',
  };
  const pendingBooking = {
    id: 'b1',
    userId: 'c1',
    priceCents: 8000,
    status: BookingStatus.PENDING_PAYMENT,
    provider: { userId: 'pu1' },
  };

  const send = (e: Stripe.Event) => {
    stripe.constructEvent.mockReturnValue(e);
    return service.handleStripeWebhook(Buffer.from('{}'), 'sig');
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    bookingRepo.findOne.mockResolvedValue(pendingBooking);
    bookingRepo.update.mockResolvedValue({ affected: 1 });
    txRepo.findOne.mockResolvedValue(null);
    const module = await Test.createTestingModule({
      providers: [
        StripeWebhookService,
        { provide: getRepositoryToken(Booking), useValue: bookingRepo },
        { provide: getRepositoryToken(Transaction), useValue: txRepo },
        { provide: getRepositoryToken(Provider), useValue: providerRepo },
        { provide: StripeService, useValue: stripe },
        { provide: PaymentsService, useValue: payments },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(StripeWebhookService);
  });

  it('rejects an invalid signature', async () => {
    stripe.constructEvent.mockImplementation(() => {
      throw new BadRequestException('Invalid Stripe signature!');
    });
    await expect(
      service.handleStripeWebhook(Buffer.from('{}'), 'bad'),
    ).rejects.toThrow(BadRequestException);
  });

  it('ignores event types it does not handle', async () => {
    await expect(send(event('customer.created', {}))).resolves.toEqual({
      received: true,
    });
    expect(bookingRepo.update).not.toHaveBeenCalled();
  });

  describe('checkout.session.completed', () => {
    it('records the held payment, hands the booking to the provider and notifies them', async () => {
      await send(event('checkout.session.completed', session));
      expect(txRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'b1',
          stripeCheckoutSessionId: 'cs_1',
          stripePaymentIntentId: 'pi_1',
          amountCents: 8000,
          commissionCents: 1600,
          providerPayoutCents: 6400,
        }),
      );
      expect(bookingRepo.update).toHaveBeenCalledWith(
        { id: 'b1', status: BookingStatus.PENDING_PAYMENT },
        { status: BookingStatus.PENDING_PROVIDER },
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        'pu1',
        'BOOKING_REQUESTED',
        { bookingId: 'b1' },
      );
    });

    it('on redelivery makes no second transaction and no second notification', async () => {
      txRepo.findOne.mockResolvedValue({ id: 't1' });
      bookingRepo.findOne.mockResolvedValue({
        ...pendingBooking,
        status: BookingStatus.PENDING_PROVIDER,
      });
      bookingRepo.update.mockResolvedValue({ affected: 0 });
      await send(event('checkout.session.completed', session));
      expect(txRepo.save).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
      expect(payments.cancelUnclaimedHold).not.toHaveBeenCalled();
    });

    it('cancels the hold when the booking was cancelled or expired meanwhile', async () => {
      bookingRepo.findOne.mockResolvedValue({
        ...pendingBooking,
        status: BookingStatus.CANCELLED,
      });
      await send(event('checkout.session.completed', session));
      expect(payments.cancelUnclaimedHold).toHaveBeenCalledWith('pi_1');
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('cancels the hold when the booking no longer exists', async () => {
      bookingRepo.findOne.mockResolvedValue(null);
      await send(event('checkout.session.completed', session));
      expect(payments.cancelUnclaimedHold).toHaveBeenCalledWith('pi_1');
    });

    it('ignores sessions that are not ours (no booking reference)', async () => {
      await send(
        event('checkout.session.completed', { ...session, client_reference_id: null }),
      );
      expect(bookingRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('checkout.session.expired', () => {
    it('cancels an unpaid booking and tells the customer', async () => {
      await send(event('checkout.session.expired', session));
      expect(bookingRepo.update).toHaveBeenCalledWith(
        { id: 'b1', status: BookingStatus.PENDING_PAYMENT },
        { status: BookingStatus.CANCELLED },
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        'c1',
        'BOOKING_PAYMENT_EXPIRED',
        { bookingId: 'b1' },
      );
    });

    it('leaves a booking that is no longer waiting for payment alone', async () => {
      bookingRepo.findOne.mockResolvedValue({
        ...pendingBooking,
        status: BookingStatus.CONFIRMED,
      });
      await send(event('checkout.session.expired', session));
      expect(bookingRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('account.updated', () => {
    const ready = {
      id: 'acct_1',
      payouts_enabled: true,
      capabilities: { transfers: 'active' },
    };

    it('marks the provider onboarded and pays out what was waiting', async () => {
      providerRepo.findOne.mockResolvedValue({ id: 'p1', stripeOnboarded: false });
      await send(event('account.updated', ready));
      expect(providerRepo.update).toHaveBeenCalledWith('p1', { stripeOnboarded: true });
      expect(payments.payoutWaiting).toHaveBeenCalledWith('p1');
    });

    it('does not pay out while the account is not ready', async () => {
      providerRepo.findOne.mockResolvedValue({ id: 'p1', stripeOnboarded: false });
      await send(event('account.updated', { ...ready, payouts_enabled: false }));
      expect(providerRepo.update).not.toHaveBeenCalled();
      expect(payments.payoutWaiting).not.toHaveBeenCalled();
    });

    it('ignores accounts that belong to no provider', async () => {
      providerRepo.findOne.mockResolvedValue(null);
      await send(event('account.updated', ready));
      expect(payments.payoutWaiting).not.toHaveBeenCalled();
    });
  });
});
```

Run: `npx jest src/payments/stripe-webhook.service.spec.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement** — `src/payments/stripe-webhook.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type Stripe from 'stripe';
import { Booking } from '../booking/entities/booking.entity';
import { BookingStatus } from '../booking/enums/booking-status.enum';
import { NotificationsService } from '../notifications/notifications.service';
import { Provider } from '../provider/entities/provider.entity';
import { Transaction } from './entities/transaction.entity';
import { splitAmount } from './money';
import { PaymentsService } from './payments.service';
import { isPayoutReady, StripeService } from './stripe.service';

@Injectable()
export class StripeWebhookService {
  constructor(
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Provider)
    private readonly providerRepository: Repository<Provider>,
    private readonly stripeService: StripeService,
    private readonly paymentsService: PaymentsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // Stripe redelivers, so every handler checks current state first and is safe to repeat
  async handleStripeWebhook(
    rawBody: Buffer,
    signature: string,
  ): Promise<{ received: true }> {
    const event = this.stripeService.constructEvent(rawBody, signature);
    switch (event.type) {
      case 'checkout.session.completed':
        await this.onCheckoutCompleted(event.data.object);
        break;
      case 'checkout.session.expired':
        await this.onCheckoutExpired(event.data.object);
        break;
      case 'account.updated':
        await this.onAccountUpdated(event.data.object);
        break;
    }
    return { received: true };
  }

  private async onCheckoutCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const bookingId = session.client_reference_id;
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
    if (!bookingId || !paymentIntentId) {
      return;
    }
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: { provider: true },
    });
    let transaction = await this.transactionRepository.findOne({
      where: { bookingId },
    });
    if (!transaction) {
      // paid for a booking that was cancelled/expired meanwhile: give the hold back
      if (!booking || booking.status !== BookingStatus.PENDING_PAYMENT) {
        await this.paymentsService.cancelUnclaimedHold(paymentIntentId);
        return;
      }
      const { commissionCents, providerPayoutCents } = splitAmount(
        booking.priceCents,
      );
      // ponytail: a cancel racing between the check above and the flip below leaves a stray hold;
      // it lapses within 7 days
      transaction = await this.transactionRepository.save(
        this.transactionRepository.create({
          bookingId,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: paymentIntentId,
          amountCents: booking.priceCents,
          commissionCents,
          providerPayoutCents,
        }),
      );
    }
    // repeating this on a redelivery is harmless: the compare-and-set matches nothing
    const { affected } = await this.bookingRepository.update(
      { id: bookingId, status: BookingStatus.PENDING_PAYMENT },
      { status: BookingStatus.PENDING_PROVIDER },
    );
    if (affected && booking) {
      this.notificationsService.notify(
        booking.provider.userId,
        'BOOKING_REQUESTED',
        { bookingId },
      );
    }
  }

  private async onCheckoutExpired(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const bookingId = session.client_reference_id;
    if (!bookingId) {
      return;
    }
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
    });
    if (booking?.status !== BookingStatus.PENDING_PAYMENT) {
      return;
    }
    const { affected } = await this.bookingRepository.update(
      { id: bookingId, status: BookingStatus.PENDING_PAYMENT },
      { status: BookingStatus.CANCELLED },
    );
    if (affected) {
      this.notificationsService.notify(
        booking.userId,
        'BOOKING_PAYMENT_EXPIRED',
        { bookingId },
      );
    }
  }

  private async onAccountUpdated(account: Stripe.Account): Promise<void> {
    const provider = await this.providerRepository.findOne({
      where: { stripeAccountId: account.id },
    });
    if (!provider || !isPayoutReady(account)) {
      return;
    }
    if (!provider.stripeOnboarded) {
      await this.providerRepository.update(provider.id, {
        stripeOnboarded: true,
      });
    }
    // also retries payouts that failed earlier
    await this.paymentsService.payoutWaiting(provider.id);
  }
}
```

- [ ] **Step 3: Controller** — `src/payments/stripe-webhook.controller.ts`

```ts
import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { StripeWebhookService } from './stripe-webhook.service';

// No auth guard: Stripe calls this, and the signature check is the authentication
@Controller('webhooks')
export class StripeWebhookController {
  constructor(private readonly stripeWebhookService: StripeWebhookService) {}

  @Post('/stripe')
  @HttpCode(200)
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    if (!req.rawBody || !signature) {
      throw new BadRequestException('Missing Stripe signature!');
    }
    return this.stripeWebhookService.handleStripeWebhook(
      req.rawBody,
      signature,
    );
  }
}
```

- [ ] **Step 4: Wire module and raw body**

`payments.module.ts`: import `NotificationsModule` (from `'../notifications/notifications.module'`) in `imports`; add `StripeWebhookService` to `providers`; add `controllers: [StripeWebhookController]`.

`src/main.ts`: `const app = await NestFactory.create(AppModule, { rawBody: true });` (Stripe signature verification needs the raw body; nothing else changes).

`src/app.module.ts`: add `PaymentsModule` to `imports` (after `BookingModule`).

- [ ] **Step 5: Run and commit**

Run: `npx jest src/payments && npm run build` — Expected: PASS, build clean.
```bash
npx eslint src --fix
git add src
git commit -m "Phase 5: Stripe webhook (payment authorised, session expired, account updated)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Booking lifecycle integration

**Files:**
- Modify: `src/booking/services/booking.service.ts`, `src/booking/services/booking.service.spec.ts`, `src/booking/booking.controller.ts`, `src/booking/booking.module.ts`

**Interfaces:**
- Consumes: `PaymentsService.createCheckout / releaseHold / captureAndPayout` (Task 4).
- Produces: `createBooking(userId, data): Promise<{ booking: Booking; checkoutUrl: string }>`; `createBookingCheckout(userId, id): Promise<{ checkoutUrl: string }>`; route `POST /bookings/:id/checkout`. Providers get 404 for `PENDING_PAYMENT` bookings everywhere.

- [ ] **Step 1: Update the spec harness and write the failing tests** in `booking.service.spec.ts`

Harness changes:
```ts
import { PaymentsService } from '../../payments/payments.service';
// ...
  const payments = {
    createCheckout: jest.fn(),
    releaseHold: jest.fn(),
    captureAndPayout: jest.fn(),
  };
```
add `delete: jest.fn()` to `bookingRepo`; in `beforeEach` add `payments.createCheckout.mockResolvedValue('https://pay.test/c1');` and register `{ provide: PaymentsService, useValue: payments }` in the testing module's providers. (`jest.clearAllMocks()` keeps implementations set by `mockResolvedValue`, so set them in `beforeEach` after it.)

Replace the existing test `creates a PENDING_PROVIDER booking priced from the catalog and notifies the provider` with:
```ts
    it('creates a PENDING_PAYMENT booking priced from the catalog and returns the checkout url', async () => {
      const result = await service.createBooking('c1', data);
      expect(result.booking.status).toBe(BookingStatus.PENDING_PAYMENT);
      expect(result.booking.priceCents).toBe(12000);
      expect(result.booking.durationMinutes).toBe(60);
      expect(result.checkoutUrl).toBe('https://pay.test/c1');
      expect(payments.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'b1', priceCents: 12000 }),
        expect.any(String),
      );
    });

    it('does not tell the provider until the customer has paid', async () => {
      await service.createBooking('c1', data);
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('removes the booking again when the checkout cannot be created', async () => {
      payments.createCheckout.mockRejectedValue(new Error('stripe down'));
      await expect(service.createBooking('c1', data)).rejects.toThrow('stripe down');
      expect(bookingRepo.delete).toHaveBeenCalledWith('b1');
    });
```
(`planService.getSubService` mock in `beforeEach` has no `name`; add `name: 'Regular home clean'` to that mock object.)

New describes (use `makeBooking` and the harness above; provider-side calls use `providerRepo.findOne` already mocked in `beforeEach`):
```ts
  describe('createBookingCheckout', () => {
    it('issues a fresh checkout url while the booking awaits payment', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeBooking({ status: BookingStatus.PENDING_PAYMENT }),
      );
      await expect(service.createBookingCheckout('c1', 'b1')).resolves.toEqual({
        checkoutUrl: 'https://pay.test/c1',
      });
    });

    it('409 when the booking is not waiting for payment', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      await expect(service.createBookingCheckout('c1', 'b1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('404 for someone else’s booking', async () => {
      bookingRepo.findOne.mockResolvedValue(null);
      await expect(service.createBookingCheckout('x', 'b1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('payments hooks', () => {
    it('cancelling an unpaid booking cancels it without bothering the provider', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeBooking({ status: BookingStatus.PENDING_PAYMENT }),
      );
      const result = await service.cancelBooking('c1', 'b1');
      expect(result.status).toBe(BookingStatus.CANCELLED);
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('cancelling a paid booking releases the card hold', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      await service.cancelBooking('c1', 'b1');
      expect(payments.releaseHold).toHaveBeenCalledWith('b1');
    });

    it('declining releases the card hold', async () => {
      bookingRepo.findOne.mockResolvedValue(makeBooking());
      await service.declineBooking('pu1', 'b1');
      expect(payments.releaseHold).toHaveBeenCalledWith('b1');
    });

    it('completing captures the payment before marking COMPLETED', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeBooking({ status: BookingStatus.IN_PROGRESS }),
      );
      const order: string[] = [];
      payments.captureAndPayout.mockImplementation(() => {
        order.push('capture');
        return Promise.resolve();
      });
      bookingRepo.update.mockImplementation(() => {
        order.push('update');
        return Promise.resolve({ affected: 1 });
      });
      const result = await service.completeBooking('pu1', 'b1');
      expect(order).toEqual(['capture', 'update']);
      expect(result.status).toBe(BookingStatus.COMPLETED);
    });

    it('a failed capture leaves the booking IN_PROGRESS', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeBooking({ status: BookingStatus.IN_PROGRESS }),
      );
      payments.captureAndPayout.mockRejectedValue(new Error('capture failed'));
      await expect(service.completeBooking('pu1', 'b1')).rejects.toThrow('capture failed');
      expect(bookingRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('providers and unpaid bookings', () => {
    const unpaid = () => makeBooking({ status: BookingStatus.PENDING_PAYMENT });

    it.each(['acceptBooking', 'declineBooking', 'startBooking', 'completeBooking'] as const)(
      '%s answers 404 for an unpaid booking',
      async (method) => {
        bookingRepo.findOne.mockResolvedValue(unpaid());
        await expect(service[method]('pu1', 'b1')).rejects.toThrow(NotFoundException);
      },
    );

    it('the assigned provider cannot read an unpaid booking', async () => {
      bookingRepo.findOne.mockResolvedValue(unpaid());
      await expect(service.getBooking('pu1', Role.PROVIDER, 'b1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('the provider’s list hides unpaid bookings but the customer’s does not', async () => {
      bookingRepo.find.mockResolvedValue([]);
      await service.listBookings('pu1', Role.PROVIDER, {});
      const providerWhere = (bookingRepo.find.mock.calls[0] as [{ where: { status: unknown } }])[0].where;
      expect(providerWhere.status).toEqual(
        Not(In([BookingStatus.IN_PROGRESS, BookingStatus.PENDING_PAYMENT])),
      );
      await service.listBookings('c1', Role.CUSTOMER, {});
      const customerWhere = (bookingRepo.find.mock.calls[1] as [{ where: { status: unknown } }])[0].where;
      expect(customerWhere.status).toEqual(Not(BookingStatus.IN_PROGRESS));
    });

    it('an explicit ?status=PENDING_PAYMENT shows a provider nothing', async () => {
      await expect(
        service.listBookings('pu1', Role.PROVIDER, { status: BookingStatus.PENDING_PAYMENT }),
      ).resolves.toEqual([]);
      expect(bookingRepo.find).not.toHaveBeenCalled();
    });
  });
```
Add `In` to the `typeorm` import (`import { In, Not } from 'typeorm';`).

Run: `npx jest src/booking/services/booking.service.spec.ts`
Expected: FAIL — compile errors / failures for the new API (`createBookingCheckout` missing, `createBooking` returns a booking, etc.).

- [ ] **Step 2: Implement in `booking.service.ts`**

Imports: `PaymentsService` from `'../../payments/payments.service'`; `In` from `typeorm`.

Add below `EDITABLE_STATUSES`:
```ts
// an unpaid booking can also be cancelled
const CANCELLABLE_STATUSES = [BookingStatus.PENDING_PAYMENT, ...EDITABLE_STATUSES];

type TransitionHooks = {
  before?: (booking: Booking) => Promise<void>;
  after?: (booking: Booking) => Promise<void>;
};
```
Constructor: add `private readonly paymentsService: PaymentsService,` after `notificationsService`.

`createBooking` — new return type and tail (everything before `const booking = ...save` is unchanged):
```ts
  async createBooking(
    userId: string,
    data: CreateBookingDto,
  ): Promise<{ booking: Booking; checkoutUrl: string }> {
    // ... unchanged checks ...
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
```
`declineBooking` / `completeBooking` — pass hooks as a 6th argument and delete the old `// Phase 5: capture ...` comment:
```ts
      'BOOKING_DECLINED',
      { after: (booking) => this.paymentsService.releaseHold(booking.id) },
```
```ts
      'BOOKING_COMPLETED',
      // capture first: if Stripe fails the booking stays IN_PROGRESS and the provider retries
      { before: (booking) => this.paymentsService.captureAndPayout(booking) },
```
`cancelBooking` — use `CANCELLABLE_STATUSES` in the check and replace the tail:
```ts
    const saved = await this.updateWhileStatus(booking, {
      status: BookingStatus.CANCELLED,
    });
    await this.paymentsService.releaseHold(booking.id);
    // a booking nobody has paid for yet was never shown to the provider
    if (booking.status !== BookingStatus.PENDING_PAYMENT) {
      this.notificationsService.notify(booking.provider.userId, 'BOOKING_CANCELLED', { bookingId: booking.id });
    }
    return saved;
```
Careful: `updateWhileStatus` mutates `booking` via `Object.assign` (status becomes CANCELLED). Capture `const wasPaid = booking.status !== BookingStatus.PENDING_PAYMENT;` **before** calling it and use `wasPaid` in the `if`.

`listBookings`:
```ts
    const hidden =
      role === Role.PROVIDER
        ? Not(In([BookingStatus.IN_PROGRESS, BookingStatus.PENDING_PAYMENT]))
        : Not(BookingStatus.IN_PROGRESS);
    return this.findForUser(userId, role, query.status ?? hidden);
```
`findForUser` — first lines of the method body:
```ts
    // providers never see bookings that are still waiting for the customer's payment
    if (role === Role.PROVIDER && status === BookingStatus.PENDING_PAYMENT) {
      return [];
    }
```
`getBooking` — in `isAssignedProvider` add `&& booking.status !== BookingStatus.PENDING_PAYMENT` (after the `booking?.provider.userId === userId` term).

`transitionAsProvider` — new signature and body changes:
```ts
    event: string,
    hooks: TransitionHooks = {},
  ): Promise<Booking> {
    // ...
    if (!booking || booking.status === BookingStatus.PENDING_PAYMENT) {
      throw new NotFoundException('Booking not found!');
    }
    if (booking.status !== from) { /* unchanged 409 */ }
    await hooks.before?.(booking);
    const saved = await this.updateWhileStatus(booking, { status: to });
    await hooks.after?.(saved);
    this.notificationsService.notify(...unchanged);
    return saved;
```

- [ ] **Step 3: Controller and module**

`booking.controller.ts` — add (after `createBooking`):
```ts
  @Post('/:id/checkout')
  @Roles(Role.CUSTOMER)
  async createBookingCheckout(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.createBookingCheckout(req.user.id, id);
  }
```
`booking.module.ts` — import `PaymentsModule` (`'../payments/payments.module'`) in `imports`.

- [ ] **Step 4: Run, fix, commit**

Run: `npx jest && npm run build`
Expected: all suites PASS (80 prior tests adjusted + new ones). If an older test fails because it expected the previous `createBooking` shape or the cancel notification for a status it now treats differently, fix the test to the new behaviour only when the change is intended by the spec; otherwise fix the code.
```bash
npx eslint src --fix
git add src
git commit -m "Phase 5: pay-first booking flow (PENDING_PAYMENT, checkout url, capture on complete, hold release)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Provider Stripe connect, earnings, receipts, admin transactions

**Files:**
- Create: `src/payments/payments.controller.ts`, `src/payments/dto/list-transactions-query.dto.ts`
- Modify: `src/payments/payments.service.ts`, `src/payments/payments.service.spec.ts`, `src/payments/payments.module.ts`

**Interfaces:**
- Produces on `PaymentsService`:
  - `connectStripeAccount(userId: string): Promise<{ onboardingUrl: string }>`
  - `getEarnings(userId: string): Promise<{ releasedCents; awaitingPayoutCents; heldCents; stripeConnected: boolean; jobs: { bookingId; serviceName; scheduledAt; status; providerPayoutCents }[] }>`
  - `getReceipts(userId: string): Promise<{ transactionId; bookingId; serviceName; scheduledAt; amountCents; createdAt }[]>`
  - `listTransactions(query: ListTransactionsQueryDto): Promise<Transaction[]>`
- Routes: `POST /provider/stripe-account`, `GET /provider/earnings` (PROVIDER); `GET /user/receipts` (CUSTOMER); `GET /admin/transactions?status=` (ADMIN).

- [ ] **Step 1: Failing tests** — append to `payments.service.spec.ts` (inside the outer `describe`; `providerRepo.findOne` default is the `connected` provider; add `import { NotFoundException } from '@nestjs/common';`)

```ts
  describe('connectStripeAccount', () => {
    it('creates an Express account once, stores it and returns the onboarding link', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        stripeAccountId: null,
        user: { email: 'pro@x.co' },
      });
      stripe.createConnectedAccount.mockResolvedValue('acct_new');
      stripe.createAccountLink.mockResolvedValue('https://connect.test/onboard');

      const result = await service.connectStripeAccount('pu1');

      expect(stripe.createConnectedAccount).toHaveBeenCalledWith('pro@x.co', 'p1');
      expect(providerRepo.update).toHaveBeenCalledWith('p1', { stripeAccountId: 'acct_new' });
      expect(stripe.createAccountLink).toHaveBeenCalledWith('acct_new');
      expect(result).toEqual({ onboardingUrl: 'https://connect.test/onboard' });
    });

    it('reuses the existing account (a provider can come back to finish onboarding)', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        stripeAccountId: 'acct_old',
        user: { email: 'pro@x.co' },
      });
      stripe.createAccountLink.mockResolvedValue('https://connect.test/again');
      await service.connectStripeAccount('pu1');
      expect(stripe.createConnectedAccount).not.toHaveBeenCalled();
      expect(stripe.createAccountLink).toHaveBeenCalledWith('acct_old');
    });

    it('404 when the user has no provider profile', async () => {
      providerRepo.findOne.mockResolvedValue(null);
      await expect(service.connectStripeAccount('x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getEarnings', () => {
    const row = (over: object) => ({
      id: 't',
      bookingId: 'b',
      status: TransactionStatus.RELEASED,
      providerPayoutCents: 1000,
      booking: { scheduledAt: new Date('2030-01-01T10:00:00Z'), subService: { name: 'Clean' } },
      ...over,
    });

    it('totals released, awaiting-payout and held money and ignores cancelled holds', async () => {
      txRepo.find.mockResolvedValue([
        row({ status: TransactionStatus.RELEASED, providerPayoutCents: 6400 }),
        row({ status: TransactionStatus.CAPTURED, providerPayoutCents: 800 }),
        row({ status: TransactionStatus.HELD, providerPayoutCents: 2000 }),
        row({ status: TransactionStatus.CANCELLED, providerPayoutCents: 9999 }),
      ]);
      const result = await service.getEarnings('pu1');
      expect(result).toMatchObject({
        releasedCents: 6400,
        awaitingPayoutCents: 800,
        heldCents: 2000,
        stripeConnected: true,
      });
      expect(result.jobs).toHaveLength(3);
    });

    it('reports stripeConnected false for a provider who skipped Stripe', async () => {
      providerRepo.findOne.mockResolvedValue({ id: 'p1', stripeOnboarded: false });
      txRepo.find.mockResolvedValue([]);
      await expect(service.getEarnings('pu1')).resolves.toMatchObject({
        stripeConnected: false,
        releasedCents: 0,
      });
    });
  });

  describe('getReceipts', () => {
    it('lists the customer’s paid bookings', async () => {
      txRepo.find.mockResolvedValue([
        {
          id: 't1',
          bookingId: 'b1',
          amountCents: 8000,
          createdAt: new Date('2030-01-01T00:00:00Z'),
          booking: { scheduledAt: new Date('2030-01-02T10:00:00Z'), subService: { name: 'Deep clean' } },
        },
      ]);
      await expect(service.getReceipts('c1')).resolves.toEqual([
        {
          transactionId: 't1',
          bookingId: 'b1',
          serviceName: 'Deep clean',
          scheduledAt: new Date('2030-01-02T10:00:00Z'),
          amountCents: 8000,
          createdAt: new Date('2030-01-01T00:00:00Z'),
        },
      ]);
    });
  });

  describe('listTransactions', () => {
    it('filters by status when given', async () => {
      txRepo.find.mockResolvedValue([]);
      await service.listTransactions({ status: TransactionStatus.HELD });
      expect(txRepo.find).toHaveBeenCalledWith({
        where: { status: TransactionStatus.HELD },
        order: { createdAt: 'DESC' },
      });
    });

    it('lists everything without a filter', async () => {
      txRepo.find.mockResolvedValue([]);
      await service.listTransactions({});
      expect(txRepo.find).toHaveBeenCalledWith({ where: {}, order: { createdAt: 'DESC' } });
    });
  });
```
Run: `npx jest src/payments/payments.service.spec.ts` — Expected: FAIL (methods missing).

- [ ] **Step 2: DTO** — `src/payments/dto/list-transactions-query.dto.ts`

```ts
import { IsEnum, IsOptional } from 'class-validator';
import { TransactionStatus } from '../enums/transaction-status.enum';

export class ListTransactionsQueryDto {
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;
}
```

- [ ] **Step 3: Implement** — add to `PaymentsService` (imports: `In` from `typeorm`, `ListTransactionsQueryDto`):

```ts
  // optional, any time: a provider who skipped Stripe at onboarding connects later
  async connectStripeAccount(userId: string): Promise<{ onboardingUrl: string }> {
    const provider = await this.providerRepository.findOne({
      where: { userId },
      relations: { user: true },
    });
    if (!provider) {
      throw new NotFoundException('Provider profile not found!');
    }
    let accountId = provider.stripeAccountId;
    if (!accountId) {
      accountId = await this.stripeCall(() =>
        this.stripeService.createConnectedAccount(provider.user.email, provider.id),
      );
      await this.providerRepository.update(provider.id, { stripeAccountId: accountId });
    }
    const connectedAccountId = accountId;
    const onboardingUrl = await this.stripeCall(() =>
      this.stripeService.createAccountLink(connectedAccountId),
    );
    return { onboardingUrl };
  }

  async getEarnings(userId: string) {
    const provider = await this.providerRepository.findOne({ where: { userId } });
    if (!provider) {
      throw new NotFoundException('Provider profile not found!');
    }
    const rows = await this.transactionRepository.find({
      where: { booking: { providerId: provider.id } },
      relations: { booking: { subService: true } },
      order: { createdAt: 'DESC' },
    });
    const live = rows.filter((row) => row.status !== TransactionStatus.CANCELLED);
    const total = (status: TransactionStatus) =>
      live
        .filter((row) => row.status === status)
        .reduce((sum, row) => sum + row.providerPayoutCents, 0);
    return {
      releasedCents: total(TransactionStatus.RELEASED),
      awaitingPayoutCents: total(TransactionStatus.CAPTURED),
      heldCents: total(TransactionStatus.HELD),
      stripeConnected: provider.stripeOnboarded,
      jobs: live.map((row) => ({
        bookingId: row.bookingId,
        serviceName: row.booking.subService.name,
        scheduledAt: row.booking.scheduledAt,
        status: row.status,
        providerPayoutCents: row.providerPayoutCents,
      })),
    };
  }

  async getReceipts(userId: string) {
    const rows = await this.transactionRepository.find({
      where: {
        status: In([TransactionStatus.CAPTURED, TransactionStatus.RELEASED]),
        booking: { userId },
      },
      relations: { booking: { subService: true } },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => ({
      transactionId: row.id,
      bookingId: row.bookingId,
      serviceName: row.booking.subService.name,
      scheduledAt: row.booking.scheduledAt,
      amountCents: row.amountCents,
      createdAt: row.createdAt,
    }));
  }

  async listTransactions(query: ListTransactionsQueryDto): Promise<Transaction[]> {
    return this.transactionRepository.find({
      where: query.status ? { status: query.status } : {},
      order: { createdAt: 'DESC' },
    });
  }
```

- [ ] **Step 4: Controller** — `src/payments/payments.controller.ts`

```ts
import { Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { Role } from '../user/enums/role.enum';
import { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { PaymentsService } from './payments.service';

@Controller()
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('/provider/stripe-account')
  @Roles(Role.PROVIDER)
  async connectStripeAccount(@Req() req: AuthenticatedRequest) {
    return this.paymentsService.connectStripeAccount(req.user.id);
  }

  @Get('/provider/earnings')
  @Roles(Role.PROVIDER)
  async getEarnings(@Req() req: AuthenticatedRequest) {
    return this.paymentsService.getEarnings(req.user.id);
  }

  @Get('/user/receipts')
  @Roles(Role.CUSTOMER)
  async getReceipts(@Req() req: AuthenticatedRequest) {
    return this.paymentsService.getReceipts(req.user.id);
  }

  @Get('/admin/transactions')
  @Roles(Role.ADMIN)
  async listTransactions(@Query() query: ListTransactionsQueryDto) {
    return this.paymentsService.listTransactions(query);
  }
}
```
`payments.module.ts`: add `PaymentsController` to `controllers`. The module already imports what `AuthGuard('jwt')`/`RolesGuard` need if other feature modules (e.g. `BookingModule`) work the same way — mirror `booking.module.ts` imports if the app fails to resolve the guard.

- [ ] **Step 5: Run and commit**

Run: `npx jest && npm run build` — Expected: PASS.
```bash
npx eslint src --fix
git add src
git commit -m "Phase 5: provider Stripe connect, earnings, receipts and admin transactions

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Demo seed, docs, Postman, project files, final checks

**Files:**
- Modify: `src/database/seeds/demo-data.seed.ts`, `DEMO_DATA.md`, `PHASE_4_API.md`, `PHASE_4_MODULE_GUIDE.md`, `postman/Handy-AI.postman_collection.json`, `PLAN.md`, `CLAUDE.md`
- Create: `PHASE_5_API.md`, `PHASE_5_MODULE_GUIDE.md`

- [ ] **Step 1: Seed — payments for the demo bookings**

In `demo-data.seed.ts`:
- Import `Transaction` (`'../../payments/entities/transaction.entity'`) and `TransactionStatus` (`'../../payments/enums/transaction-status.enum'`); import `splitAmount` from `'../../payments/money'`.
- Pick the provider who has **no** Stripe account: `const UNCONNECTED = 'grace';`. Run `grep -n "status: S.COMPLETED" -B6 src/database/seeds/demo-data.seed.ts` — if `grace` has no COMPLETED booking, set `UNCONNECTED` to a provider key that does (this is what shows the "awaiting payout" earnings case).
- In the provider creation (`manager.create(Provider, {...})`) add:
  ```ts
          stripeAccountId: p.key === UNCONNECTED ? null : `acct_demo_${p.key}`,
          stripeOnboarded: p.key !== UNCONNECTED,
  ```
- After each `placed.push(await manager.save(manager.create(Booking, {...})))`, save a transaction for it. Restructure the push so the saved booking is in a variable `booking`, then:
  ```ts
      const n = placed.length; // 1-based after the push
      const { commissionCents, providerPayoutCents } = splitAmount(booking.priceCents);
      const status =
        spec.status === S.COMPLETED
          ? provider.stripeOnboarded
            ? TransactionStatus.RELEASED
            : TransactionStatus.CAPTURED
          : spec.status === S.DECLINED || spec.status === S.CANCELLED
            ? TransactionStatus.CANCELLED
            : TransactionStatus.HELD; // PENDING_PROVIDER, CONFIRMED, IN_PROGRESS
      const captured = status === TransactionStatus.RELEASED || status === TransactionStatus.CAPTURED;
      await manager.save(
        manager.create(Transaction, {
          bookingId: booking.id,
          stripeCheckoutSessionId: `cs_demo_${n}`,
          stripePaymentIntentId: `pi_demo_${n}`,
          stripeChargeId: captured ? `ch_demo_${n}` : null,
          amountCents: booking.priceCents,
          commissionCents,
          providerPayoutCents,
          status,
          stripeTransferId: status === TransactionStatus.RELEASED ? `tr_demo_${n}` : null,
        }),
      );
  ```
  (`provider` here is the in-memory `Provider` saved earlier, so `provider.stripeOnboarded` is the value just inserted.)
- `removeDemoData` needs no change (transactions cascade with their bookings).
- Update the final console summary to also print the transaction count (`await count('transactions', ...)` for demo bookings).

Verify against **local only**:
```bash
LOCAL_URL=$(grep '^#DATABASE_URL=' .env | cut -d= -f2-)
echo "target: ${LOCAL_URL#*@}"   # must be localhost — else STOP
DATABASE_URL="$LOCAL_URL" npm run migration:run
DATABASE_URL="$LOCAL_URL" npm run seed:demo
DATABASE_URL="$LOCAL_URL" npm run seed:demo   # twice: proves it is re-runnable
```
Expected: second run succeeds, prints the target host `localhost:5432`, counts non-zero. Then spot-check: `psql "$LOCAL_URL" -c "select status, count(*) from transactions group by 1"` shows RELEASED/CAPTURED/HELD/CANCELLED rows.

- [ ] **Step 2: Docs**

`PHASE_5_API.md` — same style as `PHASE_4_API.md` (base URL, auth/conventions, endpoint sections with role, body, response table, errors). Must cover: the pay-first flow diagram; **changed `POST /bookings`** → `201 { booking: {…status: "PENDING_PAYMENT"}, checkoutUrl }`, plus the new 400 `Bookings can be made up to 7 days ahead!` and 502; `POST /bookings/{{bookingId}}/checkout` (`{ checkoutUrl }`, 409 if not `PENDING_PAYMENT`); `POST /webhooks/stripe` (Stripe-only, headers `stripe-signature`, events handled, `stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe` for local testing, 400 on bad signature); `POST /provider/stripe-account` (`{ onboardingUrl }`, optional and callable anytime); `GET /provider/earnings` (response shape from Task 7); `GET /user/receipts`; `GET /admin/transactions?status=`; the status tables (booking `PENDING_PAYMENT`, transaction `HELD|CAPTURED|RELEASED|CANCELLED`); test card `4242 4242 4242 4242`; env vars incl. `STRIPE_SUCCESS_URL`/`STRIPE_CANCEL_URL`; note that demo-seeded transactions use fake Stripe ids.

`PHASE_5_MODULE_GUIDE.md` — same style as `PHASE_4_MODULE_GUIDE.md`: big picture + flow diagram; file list; data model; why **separate charges and transfers** (reversal of the destination-charge decision: provider may skip Stripe, payout waits); money maths; webhook handling and idempotency; failure paths table (from the spec); how `BookingService` hooks in (`before`/`after` hooks, compare-and-set unchanged); gotchas (raw body, `source_transaction`, 7-day hold, `checkout.session.expired` min 30 min, late payment guard, legacy bookings without a transaction); known gaps (unclaimed provider money policy, boundary-day hold expiry, refunds manual, no saved-card management, `transfers`-only Express account may require `card_payments` in some regions — verify in live pass); tests list.

`PHASE_4_API.md` — update `POST /bookings` (response now `{ booking, checkoutUrl }`, status `PENDING_PAYMENT`, 7-day limit, "provider is notified after payment"), the state diagram (`PENDING_PAYMENT → PENDING_PROVIDER` on payment; cancel from `PENDING_PAYMENT`), the matching rule list (slot is held while `PENDING_PAYMENT`) and the recommended run order (pay on the Checkout URL first). `PHASE_4_MODULE_GUIDE.md` — add `PENDING_PAYMENT` to the state table and a pointer to `PHASE_5_MODULE_GUIDE.md`; delete the "Phase 5 will capture" wording. `DEMO_DATA.md` — add a "Payments" section: which transaction status each booking status gets, the unconnected provider, fake Stripe ids.

- [ ] **Step 3: Postman** — add a "Payments" folder (Create Checkout Link, Connect Stripe Account, Provider Earnings, Customer Receipts, Admin Transactions, Stripe Webhook example with the `stripe-signature` header) and update the "Create Booking" item's description/test to read `checkoutUrl`. Use a small Python script that loads the collection, edits, and writes back with `json.dump(c, f, indent=2)` (default ASCII escaping, as before), then `python3 -c "import json;json.load(open('postman/Handy-AI.postman_collection.json'))"` to validate.

- [ ] **Step 4: `PLAN.md` and `CLAUDE.md`**

`PLAN.md`: replace the Phase 5 section's text with the as-built design (pay-first, separate charges and transfers, endpoints list, `Done` mark) pointing to the spec. `CLAUDE.md`: Phase 5 row → `Done`; rewrite the "Payments use Stripe Connect destination charges…" decision bullet to the new decision (separate charges and transfers — capture on platform, Transfer 80% to the provider's Express account when connected, waiting otherwise); add a dated `2026-10-30` entry covering: pay-first flow + `PENDING_PAYMENT`, 7-day horizon, optional provider Stripe onboarding (money waits), webhook events, new env vars, new endpoints, demo transactions, and the known gaps (no payout-deadline policy, boundary-day hold expiry, refunds manual, `transfers`-only Express account to be verified live). Env var list: add `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`. Remove "Not started" from the Phase 5 status.

- [ ] **Step 5: Final verification**

Run: `npm run lint && npm run build && npx jest`
Expected: lint clean, build clean, every suite PASS. Report the exact test counts. If anything fails, fix before committing; do not proceed on red.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Phase 5: demo payments, docs, Postman and project context

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Hand-off notes for the final message (not a task)

- Migration `Phase5Payments1793900000000` ran **locally only**; applying it to the server DB (and re-running `npm run seed:demo` there) is the user's call — it needs `STRIPE_*` env on the droplet too.
- Live Stripe pass needs the user's `sk_test_…` key, a webhook secret (`stripe listen`) and frontend URLs; without them SDK/webhook behaviour is covered by unit tests only — say so plainly.
- Surface the Review Focus item 6 (boundary-day hold expiry) and the spec deviation: cancelling an unpaid booking does not expire its Checkout Session; a late payment is caught by the webhook guard.
