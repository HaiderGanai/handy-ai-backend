# Phase 5 — API Reference (Payments, Postman-style)

**Base URL:** `http://localhost:3000/api/v1`

Importable version: `postman/Handy-AI.postman_collection.json` → folder **Payments** (and the
changed **Booking → Create Booking**). Variables used: `baseUrl`, `customerToken`,
`providerToken`, `adminToken`, `bookingId`, `scheduledAt` (set it first, see below).

Conventions are the same as `PHASE_4_API.md`: Bearer token on every endpoint except the Stripe
webhook, wrong role = **403**, one error shape `{ statusCode, error, message, path, timestamp }`,
money is **integer USD cents**.

## How paying works

```
Customer                      API                           Stripe              Provider
  POST /bookings ───────────▶ booking PENDING_PAYMENT ────▶ Checkout Session
  ◀── { booking, checkoutUrl }
  opens checkoutUrl, pays ──────────────────────────────▶ card AUTHORISED (held)
                              ◀── webhook checkout.session.completed
                              Transaction HELD, booking → PENDING_PROVIDER ──────▶ notified
                                                                    accept / start
                                                              ◀──── POST …/complete
                              capture the hold ─────────────▶ money lands on the platform
                              provider connected? Transfer 80% ▶ provider's Stripe account
                              no?  Transaction CAPTURED ("awaiting payout") until they connect
```

- Charged amount = the booking's `priceCents`. **20% commission** stays with the platform
  (`floor(amount × 0.20)`), the provider gets the rest. Both are stored on the `Transaction`.
- The card is only **authorised** at booking time; nothing is taken until the provider
  completes the job. Cancel or decline releases the hold.
- Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

## Statuses

| Booking status | Meaning |
|---|---|
| `PENDING_PAYMENT` (new) | created, customer has not paid. Holds the provider's slot, **invisible to providers** (404 everywhere). Auto-cancelled ~30 min after creation if unpaid. |
| `PENDING_PROVIDER` | paid; waiting for the provider to accept (as in Phase 4) |

| Transaction status | Meaning |
|---|---|
| `HELD` | card authorised, not captured |
| `CAPTURED` | captured; provider payout waiting (provider has not connected Stripe) |
| `RELEASED` | provider paid |
| `CANCELLED` | hold released, nothing charged (declined / cancelled) |

## Rules to know

- **`scheduledAt` must be within 7 days** of now (card holds expire after 7 days) — applies to
  plan, create and time edits: `400 "Bookings can be made up to 7 days ahead!"`. It must also be
  inside the provider's weekly availability window (UTC) as before.
- Providers can **skip Stripe at onboarding**. Jobs still run; their 80% waits and is sent
  automatically the moment they finish Stripe onboarding.
- A Stripe outage returns **502** `"Payment service is unavailable, please retry!"`. Missing
  Stripe keys on the server returns **503** `"Payments are not configured!"`.
- Refunds are manual in the Stripe dashboard (no endpoint).

---

## Customer

### 1. POST `{{baseUrl}}/bookings` (changed)
Body unchanged from `PHASE_4_API.md`. Response is now:

| Status | Body |
|---|---|
| **201** | `{ "booking": { "id", "status": "PENDING_PAYMENT", "priceCents", … }, "checkoutUrl": "https://checkout.stripe.com/…" }` |
| 400 | no postcode, time in the past, **more than 7 days ahead**, bad body |
| 404 / 409 | as in Phase 4 |
| 502 | Stripe unavailable (the booking is removed again, nothing is left behind) |

The provider is **not** notified yet — that happens when the payment is confirmed.

### 2. POST `{{baseUrl}}/bookings/{{bookingId}}/checkout`
Role `CUSTOMER` (owner). No body. A fresh Checkout link for a booking still waiting for payment
(lost the link, or the page was closed).

| Status | Body |
|---|---|
| **201** | `{ "checkoutUrl": "https://checkout.stripe.com/…" }` |
| 404 | not your booking |
| 409 | `"Booking is not waiting for payment!"` |

### 3. DELETE `{{baseUrl}}/bookings/{{bookingId}}` (changed)
Now also allowed from `PENDING_PAYMENT`. A paid booking's card hold is released.

### 4. GET `{{baseUrl}}/user/receipts`
Role `CUSTOMER`. Captured bookings, newest first.

**200**
```json
[
  {
    "transactionId": "…",
    "bookingId": "…",
    "serviceName": "Regular home clean",
    "scheduledAt": "2030-01-07T10:00:00.000Z",
    "amountCents": 8000,
    "createdAt": "2030-01-05T09:00:00.000Z"
  }
]
```

---

## Provider

### 5. POST `{{baseUrl}}/provider/stripe-account`
Role `PROVIDER`. No body. **Optional and callable any time.** Creates a Stripe Express account
the first time, then returns a Stripe-hosted onboarding link (call it again to resume).

**201** `{ "onboardingUrl": "https://connect.stripe.com/…" }` · 404 no provider profile · 502/503.

When Stripe reports payouts enabled (webhook `account.updated`) the provider is marked connected
and every `CAPTURED` payout is sent.

### 6. GET `{{baseUrl}}/provider/earnings`
Role `PROVIDER`.

**200**
```json
{
  "releasedCents": 6400,
  "awaitingPayoutCents": 800,
  "heldCents": 2000,
  "stripeConnected": true,
  "jobs": [
    { "bookingId": "…", "serviceName": "Deep clean", "scheduledAt": "…", "status": "RELEASED", "providerPayoutCents": 6400 }
  ]
}
```
Amounts are the provider's 80% share. `heldCents` = paid but job not finished; `awaitingPayoutCents` =
finished but Stripe not connected. Cancelled holds are not listed. Show a "Connect Stripe"
prompt when `stripeConnected` is `false`.

### 7. Booking actions (changed behaviour)
- `POST …/decline` also releases the customer's hold.
- `POST …/complete` captures the payment **first**; if Stripe fails it returns **502** and the
  booking stays `IN_PROGRESS` (retry). If the capture works but the provider payout fails, the
  booking still completes and the payout is retried later.
- Bookings created before Phase 5 have no payment and complete without a capture.
- A `PENDING_PAYMENT` booking is **404** for the provider on every action, list and detail call.

---

## Admin

### 8. GET `{{baseUrl}}/admin/transactions`
Role `ADMIN`. Optional `?status=HELD|CAPTURED|RELEASED|CANCELLED`. Newest first.

**200** `[ { "id", "bookingId", "status", "amountCents", "commissionCents", "providerPayoutCents", "stripePaymentIntentId", "stripeChargeId", "stripeTransferId", "createdAt", "updatedAt", … } ]`

---

## Stripe webhook

### 9. POST `{{baseUrl}}/webhooks/stripe`
Called by Stripe only. No Bearer token; authenticated by the `stripe-signature` header
(`400 "Invalid Stripe signature!"` / `"Missing Stripe signature!"` otherwise). Always answers
**200** `{ "received": true }` for a valid event, handled or not.

| Event | What happens |
|---|---|
| `checkout.session.completed` | creates the `HELD` transaction (80/20 split stored), booking → `PENDING_PROVIDER`, provider notified. If the booking was cancelled/expired meanwhile, the hold is cancelled instead. |
| `checkout.session.expired` | an unpaid booking → `CANCELLED`, slot freed, customer notified |
| `account.updated` | provider payouts enabled → mark connected, send all waiting payouts |

Safe to redeliver: repeats change nothing.

**Local testing:** `stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe` prints a
`whsec_…` secret → put it in `STRIPE_WEBHOOK_SECRET`.

## Environment

| Var | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` (test mode is enough to build) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` for the webhook endpoint |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | where Stripe sends the user after Checkout and Express onboarding (the frontend supplies real ones) |

## Run order (Postman)
1. Customer sets a postcode; provider onboarded + approved (Phases 3–4).
2. Set `scheduledAt` to a time within 7 days that fits the provider's availability.
3. **Create Booking** → open `checkoutUrl`, pay with `4242…`.
4. Provider: accept → start → **complete** → customer **Receipts**, provider **Earnings**
   (awaiting payout until **Connect Stripe Account** is done), admin **Transactions**.

Demo-seeded payment records use fake Stripe ids (see `DEMO_DATA.md`) — they are for browsing
receipts/earnings only; real Stripe calls on those bookings would fail.
