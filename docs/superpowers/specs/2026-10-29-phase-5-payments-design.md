# Phase 5 — Payments (Stripe): Design

Approved in chat 2026-10-29. Source scope: `PLAN.md` Phase 5, spec §4.1/§5/§6/§7.
Supersedes the Phase 5 text in `PLAN.md` where they differ (see "Decisions").

## Goal
A customer pays (card authorised and held) when a booking is created. The provider
accepts/declines/starts/completes as in Phase 4. On completion the payment is captured and
80% is paid to the provider's Stripe Express account; the platform keeps 20%. A provider may
skip Stripe onboarding; their 80% waits until they connect an account. Customers get
receipts, providers an earnings view, admins a transaction list. Refunds stay manual in the
Stripe dashboard (no refund endpoint).

## Decisions (user-approved)
1. **Pay at booking creation.** `POST /bookings` returns `{ booking, checkoutUrl }`. New
   status `PENDING_PAYMENT` precedes `PENDING_PROVIDER`; the provider sees the booking only
   after payment is authorised.
2. **7-day horizon.** Card holds expire after 7 days, so `scheduledAt` must be within 7 days of
   confirming (400 otherwise). Also closes the Phase 4 "no scheduledAt horizon" minor.
3. **Provider may skip Stripe onboarding; no gate on matching or accepting.** Their payout waits
   until they connect an account.
4. **Separate charges and transfers, not destination charges** (reverses the CLAUDE.md
   decision). Destination charges need the provider's account at payment time, which
   contradicts decision 3. Money is authorised/captured on the platform account; after capture
   we Transfer 80% to the provider (now or when they connect). The 20% is the part not
   transferred; no `application_fee_amount`.

## Data (one migration)
- `transactions` (new): `id`, `bookingId` (unique), `stripeCheckoutSessionId`,
  `stripePaymentIntentId`, `amountCents`, `commissionCents` = `floor(amount*0.20)`,
  `providerPayoutCents` = `amount - commission`, `status` `HELD | CAPTURED | RELEASED |
  CANCELLED`, `stripeTransferId` (nullable), timestamps. Amounts copied from
  `Booking.priceCents` at creation. No `REFUNDED` (manual refunds).
- `users.stripeCustomerId` (nullable) — created on first checkout, reused so saved cards persist.
- `providers.stripeOnboarded` (bool, default false) — set from `account.updated`
  (charges/payouts enabled). `stripeAccountId` already exists.
- `bookings.status` enum gains `PENDING_PAYMENT`; it joins `ACTIVE_BOOKING_STATUSES` (holds the
  slot while the customer pays).

## Flow
1. `POST /bookings`: same eligibility as Phase 4 + horizon check; creates the booking
   `PENDING_PAYMENT` and a Checkout Session (`mode: payment`, `capture_method: manual`,
   Stripe Customer, `setup_future_usage` so the card is saved and pre-selected next time,
   30-minute expiry). Returns `{ booking, checkoutUrl }`.
2. Webhook `checkout.session.completed`: create `Transaction` `HELD`, booking →
   `PENDING_PROVIDER`, notify provider.
3. Provider accept/decline/start unchanged (Phase 4 rules).
4. `completeBooking`: capture the PaymentIntent. Provider has `stripeOnboarded` → Transfer
   `providerPayoutCents`, transaction `RELEASED`. Otherwise `CAPTURED` (awaiting payout).
5. Webhook `account.updated` with payouts enabled: set `stripeOnboarded`, Transfer every
   `CAPTURED` transaction of that provider, → `RELEASED`.

## Endpoints
| Endpoint | Role | Purpose |
|---|---|---|
| `POST /bookings` (changed) | CUSTOMER | returns `{ booking, checkoutUrl }` |
| `POST /bookings/:id/checkout` | CUSTOMER (owner) | fresh Checkout link while `PENDING_PAYMENT`, else 409 |
| `POST /webhooks/stripe` | Stripe | signature-verified; `checkout.session.completed`, `checkout.session.expired`, `account.updated` |
| `POST /provider/stripe-account` | PROVIDER | create Express account if none; return onboarding link; callable any time |
| `GET /provider/earnings` | PROVIDER | released / awaiting-payout / held totals + per-job list |
| `GET /user/receipts` | CUSTOMER | paid bookings with amounts |
| `GET /admin/transactions` | ADMIN | status, amount, commission, payout; optional `?status=` |

## Failure paths
- Customer abandons Checkout: `checkout.session.expired` → booking `CANCELLED`, slot freed
  (no scheduled job).
- Provider declines / customer cancels (any status where a hold exists): cancel the
  PaymentIntent, transaction `CANCELLED`. Cancelling a `PENDING_PAYMENT` booking expires the
  Checkout Session.
- Admin reassign: payment untouched; the transfer goes to whoever completes the job.
- Capture fails at `complete`: 502, booking stays `IN_PROGRESS`, provider retries.
- Capture succeeds, Transfer fails: transaction stays `CAPTURED`; retried by the next
  `account.updated` or a retry of the payout. Transfer idempotency key = transaction id, so no
  double payout.
- Stripe error creating checkout: no orphan booking; 502 `Payment service is unavailable,
  please retry!`.
- Bad webhook signature: 400. Handlers are idempotent (check current status first), since
  Stripe redelivers.
- Money is integer cents; commission + payout always equal the amount exactly.

## Structure
`src/payments/`: `StripeService` (thin SDK wrapper — the mock boundary for tests),
`PaymentsService` (checkout creation, hold cancel, capture + payout, flush, receipts,
earnings), `WebhookController`, `AdminTransactionController`, entity + DTOs, module.
`BookingService` calls `PaymentsService` at create/cancel/decline/complete. `main.ts` enables
`rawBody` (webhook signature needs it). New dependency `stripe`; first verify it is
unit-testable under this project's CommonJS/Jest setup (CLAUDE.md ESM lesson) before building
on it.

## Env
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (already in `.env.example`), plus
`STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` (Checkout redirects; frontend supplies real ones).

## Testing
Strict TDD with Jest, Stripe mocked at `StripeService`. Specs: money split, each webhook
handler incl. repeated delivery, create-booking → checkout URL, cancel/decline release the
hold, complete with/without connected provider, payout flush, 7-day horizon, earnings totals,
role guards. Update Phase 4 specs for the new `createBooking` return and initial status.
Live pass (real Stripe test keys, `4242` card, `stripe listen`) only if the user supplies keys;
otherwise state plainly that SDK/webhook behaviour is covered by unit tests only.

## Docs
`PHASE_5_API.md`, `PHASE_5_MODULE_GUIDE.md`, Postman "Payments" folder, `PHASE_4_API.md`
update for `POST /bookings`, `PLAN.md` + `CLAUDE.md` (status table, decision-log entry for
separate charges/transfers). Demo seed adds `Transaction` rows (fake Stripe ids) for
COMPLETED / IN_PROGRESS / CONFIRMED bookings so receipts/earnings show data; existing seeded
bookings predate payments.

## Not in this phase
Refund endpoints, payout-deadline policy for providers who never connect Stripe, saved-card
management endpoints, Stripe Tax. Known gap: unclaimed provider money accumulates in the
platform balance until a policy exists (fine on a test server).
