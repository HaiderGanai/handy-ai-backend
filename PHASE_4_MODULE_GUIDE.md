# Phase 4 — Bookings: What's Happening Inside

A walkthrough of how the booking module works, why it is shaped this way, and where the
sharp edges are. Endpoint bodies and responses live in `PHASE_4_API.md`; the design and
plan are in `docs/superpowers/specs/2026-10-14-phase-4-bookings-design.md` and
`docs/superpowers/plans/2026-10-14-phase-4-bookings.md`.

## 1. The big picture

A customer asks for a service at a time. The API finds a provider and shows a **plan**
(nothing saved). If the customer confirms, a **booking** row is created and waits for the
provider. The provider accepts, starts and completes it. Along the way the customer can edit
or cancel, an admin can reassign, and after a completed job the customer can mark the
provider as trusted so future plans prefer them.

```
Customer                         API                              Provider
   │  POST /bookings/plan  ─────▶ match (no save)
   │  ◀──── plan (provider, price, duration)
   │  POST /bookings  ──────────▶ re-check, save PENDING_PROVIDER ─▶ notify
   │                                                    ◀── accept ── CONFIRMED
   │                                                    ◀── start  ── IN_PROGRESS
   │                                                    ◀── complete─ COMPLETED
   │  POST /user/trusted-providers/:id ─▶ saved (needs a COMPLETED job)
```

## 2. Files

```
src/booking/
  enums/booking-status.enum.ts      BookingStatus + ACTIVE_BOOKING_STATUSES (slot-holding states)
  entities/booking.entity.ts        the booking row
  entities/trusted-provider.entity.ts   (userId, providerId) unique pair
  eligibility.ts                    pure helpers: coversPostcode, isWithinAvailability, overlaps, assertInFuture
  dto/                              plan, create (extends plan), update, list query, reassign
  services/booking-plan.service.ts  matching — the "AI stand-in"
  services/booking.service.ts       lifecycle + trusted providers
  services/admin-booking.service.ts admin list + reassign
  booking.controller.ts             /bookings/*
  trusted-provider.controller.ts    /user/trusted-providers/:providerId
  admin-booking.controller.ts       /admin/bookings/*
  booking.module.ts
src/notifications/                  log-only NotificationsService (Phase 7 swaps the body)
src/database/migrations/…-Phase4Bookings.ts   bookings + trusted_providers tables
```

Naming follows `GUIDE.md`: controller method name = service method name
(`acceptBooking` → `acceptBooking`), routes kebab-case, errors are Nest built-ins ending in `!`.

## 3. Data model

`bookings`: `id`, `userId` (customer), `providerId`, `subServiceId`, `scheduledAt`
(timestamptz), `durationMinutes`, `priceCents`, `status`, `notes`, timestamps.

- `durationMinutes` and `priceCents` are **copied from the catalog when the booking is
  created**, so changing a catalog price later does not rewrite existing bookings, and the
  client can never set its own price.
- `providerId` is never null: a booking only exists once a provider has been chosen.
- Deleting a user cascades to their bookings; a provider **with bookings cannot be deleted**
  (`RESTRICT`) — see "Known gaps".
- `trusted_providers`: unique `(userId, providerId)`, so "trust" can't duplicate.
- `householdNotes` are **not** stored on the booking — they are read live from the
  customer's profile and shown only to the assigned provider (`getBooking`).

## 4. Matching (`BookingPlanService`)

`planBooking` is the deterministic stand-in for the future GPT-4 layer (spec §3). Its input
and output are the contract; the body is what an AI service replaces later.

1. The time must be in the future; the sub-service must exist; the customer must have a
   postcode (else 400).
2. Load all `APPROVED` providers, then **stable-sort trusted providers to the front** (the
   rest stay in creation order).
3. Walk them in order and return the first one that passes `isEligible`:
   - offers the sub-service's category;
   - `coversPostcode`: normalised (spaces removed, upper-cased) **exact** match against any
     coverage entry — no prefix/outward-code logic;
   - `isWithinAvailability`: the whole job fits in one weekly window **in UTC** and does not
     cross midnight;
   - no overlapping booking in `PENDING_PROVIDER | CONFIRMED | IN_PROGRESS`
     (`overlaps` treats back-to-back as fine).
4. Nobody eligible → 404 `No provider available for that time!`.

`assertEligible(providerId, ctx)` is the same check for a **specific** provider and is reused
by confirm, edit and admin reassign (409 if they fail). `ctx.excludeBookingId` lets a booking
ignore its own slot when it is being moved or reassigned.

`POST /bookings` does **not** trust the plan it came from: it re-runs `assertEligible` and
recomputes price/duration, because time passes and other customers book between plan and
confirm.

## 5. The state machine (`BookingService`)

| Action | Who | From → To | Notifies |
|---|---|---|---|
| create | customer | → `PENDING_PROVIDER` | provider `BOOKING_REQUESTED` |
| accept | assigned provider | `PENDING_PROVIDER` → `CONFIRMED` | customer |
| decline | assigned provider | `PENDING_PROVIDER` → `DECLINED` | customer |
| start | assigned provider | `CONFIRMED` → `IN_PROGRESS` | customer |
| complete | assigned provider | `IN_PROGRESS` → `COMPLETED` | customer |
| edit | owner | `PENDING_PROVIDER`/`CONFIRMED`; time change → `PENDING_PROVIDER` | provider |
| cancel | owner | `PENDING_PROVIDER`/`CONFIRMED` → `CANCELLED` | provider |
| reassign | admin | `PENDING_PROVIDER`/`CONFIRMED` → `PENDING_PROVIDER` (new provider) | new provider + customer |

How it is enforced:
- All four provider actions go through one private method, `transitionAsProvider(userId,
  id, from, to, event)`: look up the caller's provider row, load the booking **scoped to that
  provider** (someone else's booking → 404, never 403, so ids can't be probed), then require
  `status === from` (else 409 `Booking is X, expected Y!`). `accept`/`start` also require the
  provider's own status to be `APPROVED` (403 if an admin disabled them); `decline`/`complete`
  stay allowed so work already underway can be wrapped up.
- Customer actions load the booking scoped to `userId` (`getOwnedBooking`) — same 404 rule.
- **Compare-and-set writes.** Every status change goes through `updateWhileStatus`, which runs
  `UPDATE … WHERE id = ? AND status = <what we read> AND providerId = <what we read>` and
  throws 409 if no row matched. Without this, `save()` would blindly overwrite, so e.g. a
  customer cancelling at the same moment the provider starts could leave the booking
  IN_PROGRESS. Admin reassign does the same.
- Edit/cancel share `EDITABLE_STATUSES`. Editing only `notes` never changes the status;
  only a **different** `scheduledAt` re-validates the provider and resets to
  `PENDING_PROVIDER` so they re-accept.
- Cancel is a soft cancel (status flip), so history and the "slot is free again" logic work
  from the same table.
- `completeBooking` is where **Phase 5** will capture the Stripe payment (marked by a comment).

Read access (`getBooking`): the owner, the assigned provider, or an admin; everyone else 404.
`provider` is projected to `{ id, fullName, bio }` (the entity also holds `stripeAccountId` and
vetting fields that must not reach customers). Only the assigned provider gets
`householdNotes` and the customer's `fullName` + `address` (the job location); email/phone are
never loaded.

## 6. Trusted providers

`addTrustedProvider(userId, providerId)` requires at least one `COMPLETED` booking between
the two (403 otherwise) and uses an `upsert` on the unique pair, so tapping twice is harmless.
`planBooking` reads the customer's trusted ids and sorts them first.

## 7. Notifications

`NotificationsService.notify(userId, event, payload)` currently just writes a log line, e.g.
`notify <userId> BOOKING_CONFIRMED {"bookingId":"…"}`. Every booking transition already calls
it, so Phase 7 only has to replace the body with FCM — no caller changes.

## 8. Gotchas worth remembering

- **Stale relation overrides the foreign key.** If you load a booking *with* its `provider`
  relation and then `save()` after changing `booking.providerId`, TypeORM writes the old
  relation's id and silently reverts your change. Writes now use `update()` with explicit
  columns (so this can't bite), but keep it in mind if you ever go back to `save()`.
- **DTO `undefined` fields.** DTO class fields exist as own `undefined` properties, so merges
  check `!== undefined` per field (as in Phase 1's profile bug).
- **Postcode matching is exact.** A provider whose coverage is `["SW1", "SW3"]` (the example
  in the Phase 3 docs) will not match a customer in `SW1A 1AA`. List full postcodes, or add
  prefix matching later (change `coversPostcode` only).

## 9. Known gaps (deliberate)

- **Availability is compared in UTC** (the weekly windows carry no timezone). Add a
  per-provider timezone before launch.
- **Double-booking race:** the overlap check and the insert are separate queries with no
  lock, so two simultaneous confirms for the same slot could both succeed. A Postgres
  exclusion constraint would close it.
- **Overlap check loads the provider's active bookings** and filters in JS — fine now, add a
  date-range query if a provider accumulates many.
- **Deleting a provider that has bookings** (`DELETE /admin/providers/:id`) fails on the
  foreign key and returns a 500; it should be a clear 409. Out of this phase's scope.
- **Not done (reviewer minors, deferred):** no index on `bookings("providerId","status")` /
  `("userId")` (add in a new migration when tables grow); no upper bound on `scheduledAt`
  (a booking horizon would be a cheap guard); a provider can accept a booking whose time has
  already passed; admin reassign to the provider the booking already has resets it to
  `PENDING_PROVIDER`; `listBookings` and the admin path of `getBooking` have no unit tests
  (covered by the live pass only).
- A declined booking is final: the customer has to plan again (no auto-rematch).
- No payment yet (Phase 5) and no real push notifications yet (Phase 7).

## 10. Tests and how it was verified

- `eligibility.spec.ts` — postcode, windows, midnight, back-to-back, past dates.
- `booking-plan.service.spec.ts` — no postcode, trusted-first, skips wrong area / category /
  double-booked, no match.
- `booking.service.spec.ts` — create, every transition (and the illegal ones), edit rules,
  cancel rules, access control and household notes, trusted providers.
- `admin-booking.service.spec.ts` — reassign rules.
- **Live pass** against real Postgres + Redis with throw-away accounts: plan → create →
  conflict → accept/start/complete (with every illegal transition rejected) → edit/cancel →
  household-notes visibility → trusted provider → admin list/reassign. All statuses matched
  expectations; test data was deleted afterwards.
