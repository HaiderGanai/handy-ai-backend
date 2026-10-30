# Phase 5 — Payments: What's Happening Inside

How the payment module works, why it is shaped this way, and where the sharp edges are.
Endpoint bodies/responses: `PHASE_5_API.md`. Design: `docs/superpowers/specs/2026-10-29-phase-5-payments-design.md`,
plan: `docs/superpowers/plans/2026-10-29-phase-5-payments.md`.

## 1. The big picture

The customer pays when the booking is created, but only an **authorisation** (a hold on the
card) happens then. The money moves when the provider completes the job. The platform keeps
20% and sends 80% to the provider's Stripe Express account — immediately if they have one, or
as soon as they connect one.

```
POST /bookings ──▶ booking PENDING_PAYMENT + Stripe Checkout Session (manual capture)
customer pays ───▶ Stripe webhook checkout.session.completed
                   ├─ Transaction HELD (amount / 20% commission / 80% payout stored)
                   └─ booking → PENDING_PROVIDER, provider notified
provider accept/start (Phase 4 rules)
provider complete ▶ capture the PaymentIntent (booking stays IN_PROGRESS if this fails)
                   ├─ provider connected?  Transfer 80%  → RELEASED
                   └─ not connected        → CAPTURED, waits for account.updated
decline / cancel ──▶ cancel the PaymentIntent (hold released) → CANCELLED
```

## 2. Why separate charges and transfers (not destination charges)

The earlier plan used destination charges: the provider's Stripe account is attached to the
payment itself. That needs the provider to have an account *when the customer pays*. The
product rule is that a provider may skip Stripe at onboarding and be paid later, so the payment
is taken on the **platform** account and a **Transfer** to the provider happens afterwards.
Side benefits: an admin reassigning a booking needs no payment change (the transfer goes to
whoever completes it), and there is no `application_fee_amount` — the 20% is simply the part
not transferred.

## 3. Files

```
src/payments/
  stripe.service.ts            the ONLY file importing the Stripe SDK; isPayoutReady()
  money.ts                     splitAmount (integer cents, floor commission)
  payments.service.ts          checkout, hold release, capture + payout, connect, earnings, receipts, admin list
  stripe-webhook.service.ts    turns Stripe events into booking/transaction changes
  stripe-webhook.controller.ts POST /webhooks/stripe (no JWT guard; signature is the auth)
  payments.controller.ts       provider/stripe-account, provider/earnings, user/receipts, admin/transactions
  entities/transaction.entity.ts, enums/transaction-status.enum.ts, dto/list-transactions-query.dto.ts
src/database/migrations/1793900000000-Phase5Payments.ts
```
Every test mocks `StripeService`; nothing in the suite calls Stripe.

## 4. Data model

- `transactions` — one per booking (`bookingId` unique): `stripeCheckoutSessionId`,
  `stripePaymentIntentId`, `stripeChargeId` (set at capture), `amountCents`, `commissionCents`,
  `providerPayoutCents`, `status` (`HELD | CAPTURED | RELEASED | CANCELLED`), `stripeTransferId`.
  Amounts are copied from `Booking.priceCents` when the payment is confirmed. Deleted with their
  booking (FK cascade).
- `users.stripeCustomerId` (hidden from API output with `@Exclude`) — created on the first
  checkout and reused, which is how saved cards come back.
- `providers.stripeOnboarded` — set from the `account.updated` webhook.
- `bookings.checkoutSessionId` (migration `Phase5CheckoutSession`) tracks the one Checkout Session that counts. `bookings.status` gains `PENDING_PAYMENT`, which is part of `ACTIVE_BOOKING_STATUSES` so the
  slot is held while the customer pays.

## 5. How `BookingService` hooks in

- `createBooking` saves the booking as `PENDING_PAYMENT`, asks `PaymentsService.createCheckout`
  for the URL and returns `{ booking, checkoutUrl }`. If Stripe fails, the booking is deleted
  again (no orphan holding a slot) and the error is rethrown.
- `transitionAsProvider` gained optional `before` / `after` hooks: `complete` captures in
  `before` (so a Stripe failure leaves the booking `IN_PROGRESS`), `decline` releases the hold in
  `after`. The compare-and-set write from Phase 4 is unchanged.
- `cancelBooking` works from `PENDING_PAYMENT` too and releases the hold; the provider is only
  notified if the booking had been paid (they never saw it otherwise).
- Providers can't see `PENDING_PAYMENT`: the list filter, `?status=PENDING_PAYMENT`, detail view
  and every transition treat it as not found.

## 6. Webhook handling

`rawBody: true` in `main.ts` keeps the unparsed bytes, because Stripe signs the exact body.
`StripeService.constructEvent` verifies the signature (400 if wrong, 503 if no secret).

Stripe redelivers events, so each handler checks state first:
- **completed** — if the transaction already exists it is not recreated; the booking flip is a
  compare-and-set (`WHERE status = PENDING_PAYMENT`), so a repeat matches nothing and sends no
  second notification. If the booking is no longer `PENDING_PAYMENT` and no transaction exists
  (cancelled or expired while the customer was paying), the PaymentIntent is cancelled — this is
  what makes "cancel an unpaid booking" safe without expiring the Checkout page.
- **expired** — only cancels a booking that is still `PENDING_PAYMENT`.
- **account.updated** — only acts when the account is payout-ready (`payouts_enabled` and the
  `transfers` capability active), then pays everything `CAPTURED` for that provider. Because it
  re-runs the payouts each time, it also retries payouts that failed earlier.

## 7. Failure paths

| What fails | What happens |
|---|---|
| Stripe down when creating checkout | booking removed, **502** |
| Customer never pays | `checkout.session.expired` → `CANCELLED`, slot freed (min. Stripe expiry 30 min; we use 31) |
| Capture fails at `complete` | **502**, booking stays `IN_PROGRESS`, provider retries; a retry never captures twice (a `CAPTURED` transaction only pays out) |
| Transfer fails after a good capture | logged; booking completes; transaction stays `CAPTURED`; retried on the next `account.updated`. Idempotency key `payout-<transactionId>` prevents a double payout |
| Releasing a hold fails | logged, booking change stands, transaction stays `HELD` (visible to admins); the hold lapses on its own within 7 days |
| Booking created before Phase 5 | no transaction → `complete` skips capture |
| Card hold already lapsed at `complete` | capture fails, Stripe says the PaymentIntent is `canceled` → transaction `CANCELLED`, the booking completes, an error is logged for an admin (the provider is unpaid) |
| Customer opens a second Checkout link | `bookings.checkoutSessionId` holds the current one; the old session is expired, its `expired` event is ignored, and a second payment's hold is cancelled |
| Payout failed for an already-connected provider | admin `POST /admin/transactions/:id/payout`; `account.updated` also retries, and flips `stripeOnboarded` back to false if Stripe restricts the account |

## 8. Gotchas

- **7-day hold window:** an authorisation expires after 7 days, hence the 7-day booking horizon
  (`assertWithinHorizon`, applied to plan, create and time edits; an edit is measured from the booking's creation, because the hold started then). A job on the very last day can
  finish after the hold lapsed — shrink the horizon if that matters.
- **`source_transaction`:** the payout Transfer is tied to the captured charge so it works before
  the captured funds are in the platform's available balance (hence `stripeChargeId`).
- **Raw body:** without `rawBody: true` every webhook fails signature checking.
- **`import type` for `RawBodyRequest`:** required by `isolatedModules` + decorator metadata.
- **Express accounts:** created with the `transfers` capability only. Some regions/agreements
  may also demand `card_payments` — confirm in a live Stripe test run.
- **Saved-card pre-selection** relies on Stripe Checkout showing the customer's saved cards for a
  known `customer`; also confirm in a live run.

## 9. Known gaps (deliberate)

- No policy for providers who never connect Stripe: their 80% accumulates in the platform
  balance (fine on a test server; needs a deadline/reminder before launch).
- Refunds are manual in the Stripe dashboard (spec). No saved-card management endpoints, no tax.
- A cancel racing the payment webhook can leave a stray hold that lapses in 7 days.
- The demo data's payment records have fake Stripe ids.

## 10. Tests

- `money.spec.ts` — split and rounding. `stripe.service.spec.ts` — real signature verification
  with the SDK, missing-config 503s, `isPayoutReady`.
- `payments.service.spec.ts` — customer reuse, hold release (incl. Stripe failure), capture +
  payout in every combination, no double capture, payout flush, connect, earnings, receipts, admin list.
- `stripe-webhook.service.spec.ts` — each event, redelivery, late payment, foreign sessions.
- `booking.service.spec.ts` — pay-first create, checkout re-issue, hold hooks, capture ordering,
  providers blind to unpaid bookings, 7-day horizon.
- Live smoke (local DB): app boots, unsigned/bad-signature webhooks → 400, a correctly signed
  event → 200, unauthenticated receipts → 401. A real payment run needs Stripe test keys.
