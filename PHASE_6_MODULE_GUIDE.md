# Phase 6 — Messaging: What's Happening Inside

Endpoint bodies: `PHASE_6_API.md`. Design: `docs/superpowers/specs/2026-11-03-phase-6-messaging-design.md`,
plan: `docs/superpowers/plans/2026-11-03-phase-6-messaging.md`.

## 1. Shape
`src/messaging/`: `Message` entity (`bookingId`, `senderId`, `body`, `createdAt`, index on
`(bookingId, createdAt)`), `MessagingService`, `MessagingController` (routes under `bookings/:id/messages`),
`MessagingModule`. A thread is just "the messages with this `bookingId`" — no conversation table.
Migration `Phase6Messages1793900000002`. Bookings code was not touched.

## 2. Who can see a thread
`getParticipantBooking` is the single gate for both routes: the booking's customer, or the assigned
provider (matched through `booking.provider.userId`). Anyone else — other customers, other providers,
admins — gets the same 404 as a missing booking, so ids can't be probed. A provider also gets 404 while
the booking is `PENDING_PAYMENT`, matching how bookings hide unpaid jobs.

## 3. When writing is allowed
Reading works in every status. Writing only in `PENDING_PROVIDER`, `CONFIRMED`, `IN_PROGRESS`
(`MESSAGING_OPEN_STATUSES` in the service); anything else is a 409. Threads therefore freeze when a job
is declined, cancelled or completed.

## 4. Polling
`GET` without `after` fetches the newest `limit` rows (`ORDER BY createdAt DESC`) and reverses them.
With `after` it looks the cursor message up **scoped to this booking** (so an id from another thread is a
400, not a leak) and returns rows with `createdAt > cursor.createdAt`, oldest first.

## 5. Verified live (local DB, demo data)
Customer and provider exchange messages on a `CONFIRMED` booking; whitespace is trimmed; `after` returns
only newer ones; a third customer gets 404 on GET and POST; a `COMPLETED` booking is readable (200) but
refuses writes (409); a cursor from another booking is 400; blank body and `limit=500` are 400.
`npm run seed:demo` now adds a two-message chat to every `CONFIRMED`, `IN_PROGRESS` and `COMPLETED` demo booking.

## 6. Known gaps (deliberate)
- Message text is not scanned for phone numbers/emails; the API never *returns* contact details, but users can type them.
- No rate limiting or spam control, no unread counts, no push on new message (Phase 7 swaps the log-only `notify`).
- The cursor is `createdAt` (microseconds): two messages in the same microsecond could be skipped by a poll.
- Admins cannot read threads (dispute handling would need an admin read endpoint).
- Apply the migration on the server DB before deploying.
