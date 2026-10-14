# Phase 4 — Bookings: Design

Approved in chat 2026-10-14. Source scope: `PLAN.md` Phase 4, spec §3/§4.2/§5/§7.

## Goal
A customer requests a service for a date/time, gets a deterministic plan (provider,
time, duration, price), confirms it, and the provider accepts/declines/starts/completes
it. Customers can edit/cancel, mark providers trusted, and admins can list/reassign.
Payments (Phase 5) and real notifications (Phase 7) are hooks only.

## Structure
`src/booking/` mirroring `src/provider/`: `entities/`, `enums/`, `dto/`, `services/`.
- `BookingPlanService` — eligibility + matching. The GPT-4 stand-in: the only file
  replaced when the AI layer lands (carries the `ponytail:` marker from PLAN.md).
- `BookingService` — lifecycle. `AdminBookingService` — list + reassign.
- Controllers: `/bookings`, `/admin/bookings`, `/user/trusted-providers`.
- `src/notifications/`: log-only `NotificationsService.notify(userId, event, payload)`
  (per CLAUDE.md decision; Phase 7 swaps the implementation).
- One migration: `bookings`, `trusted_providers` (unique `userId`+`providerId`).

## Data
`Booking`: `id`, `userId`, `providerId` (non-null — chosen before creation),
`subServiceId`, `scheduledAt` (timestamptz), `durationMinutes`, `priceCents` (int),
`status`, `notes`, timestamps.
Status: `PENDING_PROVIDER | CONFIRMED | DECLINED | IN_PROGRESS | COMPLETED | CANCELLED`
(`PLAN_PROPOSED` dropped — plans aren't persisted).
`TrustedProvider`: `userId`, `providerId`, `createdAt`.
Household notes are read live from the user at `GET /bookings/:id`, assigned provider only.

## Eligibility (plan, confirm, edit, reassign)
Provider is eligible if: status `APPROVED`; offers the sub-service's category; customer
`User.postcode` (required, else 400) matches an entry in `postcodeCoverage`
(case/whitespace-insensitive exact match); an availability window for the day of week
contains `[scheduledAt, scheduledAt+duration]`; no overlapping booking in
`PENDING_PROVIDER | CONFIRMED | IN_PROGRESS`. `scheduledAt` must be in the future.
Trusted provider is tried first, else first eligible. Plan returns a single best match
(404-style "no provider available" if none).

## Endpoints / transitions
- `POST /bookings/plan` — stateless; `{ subServiceId, scheduledAt, notes? }` → plan.
- `POST /bookings` — `{ subServiceId, scheduledAt, providerId, notes? }`; re-runs
  eligibility, recomputes price/duration server-side → `PENDING_PROVIDER`; notifies provider.
- Provider: `accept` (PENDING_PROVIDER→CONFIRMED), `decline` (→DECLINED),
  `start` (CONFIRMED→IN_PROGRESS), `complete` (IN_PROGRESS→COMPLETED; Phase 5 capture hook).
  Only the assigned provider; illegal transitions → 409.
- `PATCH /bookings/:id` — customer; only PENDING_PROVIDER/CONFIRMED; edits `scheduledAt`/`notes`.
  Time change re-validates the same provider (409 if not eligible); on CONFIRMED resets
  to PENDING_PROVIDER. No auto-rematch.
- `DELETE /bookings/:id` — customer soft cancel (→CANCELLED) from PENDING_PROVIDER/CONFIRMED.
- `GET /bookings?status=` — customer: own; provider: own jobs. `GET /bookings/:id` —
  owner / assigned provider / admin, else 404.
- `POST /user/trusted-providers/:providerId` — requires a COMPLETED booking with that
  provider; idempotent.
- Admin: `GET /admin/bookings`; `POST /admin/bookings/:id/reassign` `{ providerId }` —
  eligibility check, from PENDING_PROVIDER/CONFIRMED only, resets to PENDING_PROVIDER.

## Known shortcuts
- Availability compared in UTC (windows have no timezone) — per-provider timezone before US launch.
- Overlap check is check-then-insert, no lock — Postgres exclusion constraint later.

## Testing & docs
Jest unit specs: matching (window, overlap, trusted-first, postcode) and state
transitions incl. illegal ones. Live verification against real DB/Redis. Then
`PHASE_4_MODULE_GUIDE.md`, `PHASE_4_API.md`, Postman folder, `CLAUDE.md` + `PLAN.md` updates.
