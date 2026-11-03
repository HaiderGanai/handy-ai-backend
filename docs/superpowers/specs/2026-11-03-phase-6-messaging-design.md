# Phase 6 — In-App Messaging: Design

Source scope: `PLAN.md` Phase 6, spec §4.2/§5 ("Direct messaging between user and assigned provider
through Handy. No external contact details are shared."). Written from `PLAN.md` at the user's
request, without a discussion round - the calls in "Decisions" are mine, flagged for review.

## Goal
The customer and the assigned provider of a booking can exchange text messages inside the app,
and nobody else can read or write them. Delivery is REST + client polling.

## Non-goals (do not build)
WebSocket/real-time gateway, push on new message (only a `notify()` call - Phase 7 makes it real),
read receipts / unread counts, attachments, editing or deleting messages, an inbox across
bookings, admin access to threads, scanning message text for phone numbers/emails.

## Decisions (my calls - not yet user-approved)
1. **One thread per booking**, no separate `Conversation` entity. A thread is "all messages with this `bookingId`".
2. **Participants** = the booking's customer (`booking.userId`) and the assigned provider
   (`booking.provider.userId`). Everyone else (other customers/providers, admins) gets **404**, the
   same non-leaking rule as bookings. A provider also gets 404 while the booking is
   `PENDING_PAYMENT` (the booking is invisible to them until paid).
3. **Reading** is allowed in every booking status (history stays readable after completion/cancel).
   **Writing** is allowed only in `PENDING_PROVIDER`, `CONFIRMED`, `IN_PROGRESS`; any other status -> **409**
   (`'Messaging is closed for this booking!'`). So a customer can't message before paying, and threads freeze
   once a job is declined, cancelled or completed.
4. **No contact details leak:** responses contain only `id`, `bookingId`, `senderId`, `sender`
   (`CUSTOMER` | `PROVIDER`, derived from `senderId === booking.userId`), `body`, `createdAt`. No user/provider
   rows are joined or returned. Message *text* is not inspected (users can still type a number; known gap).
5. **Polling:** `GET` returns oldest-first. `?after=<messageId>` returns only messages newer than that
   message; `?limit=` 1-100, default 50. Without `after` it returns the *latest* `limit` messages (still
   oldest-first). Unknown/foreign `after` id -> 400.
6. **Body:** trimmed, 1-1000 characters.
7. After a send, `NotificationsService.notify(otherPartyUserId, 'MESSAGE_RECEIVED', { bookingId })` -
   never the body.

## Data (one migration)
`messages`: `id` uuid PK, `bookingId` uuid FK -> bookings `ON DELETE CASCADE`, `senderId` uuid FK -> users
`ON DELETE CASCADE`, `body` text not null, `createdAt` timestamptz default now. Index on
`(bookingId, createdAt)`. Deleting demo users/bookings cleans messages up through the cascade.

## API (global prefix `api/v1`, JWT guard, roles CUSTOMER + PROVIDER)
- `POST /bookings/:id/messages` body `{ body }` -> 201, the created message.
- `GET /bookings/:id/messages?after=&limit=` -> `{ messages: Message[] }`.
Declared on a new `MessagingController` under `@Controller('bookings')` in a new `MessagingModule`
(not in `BookingController`, keeps booking code untouched).

## Known gaps (record in CLAUDE.md when built)
Text is not scrubbed for contact details; no rate limiting / spam control; polling cursor uses
`createdAt` so two messages in the same microsecond could be skipped; no unread state; admins can't
read threads for dispute handling (add an admin read endpoint if support needs it).
