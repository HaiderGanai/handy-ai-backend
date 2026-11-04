# Phase 9 — Handy AI Chat: Design

Source scope: `Handy AI - Project Specs.md` §3 (AI Conversational Interface) and §4.2 ("the app opens
directly to the Handy chat"), plus `CLAUDE.md` "Explicit scope cuts" (the GPT-4 layer was deferred until
asked for; the user has now asked). Written at the user's request after the architecture was discussed in
chat (tool-calling loop on top of the existing services); the specific calls below are mine.

## Goal
A customer talks to Handy in free text. Handy works out the service, date/time and location, asks at most
one or two follow-up questions, shows a **plan** (provider, time, duration, price), and - only after the
customer taps Confirm - places the booking and hands back the Stripe Checkout link. The customer never
calls booking APIs themselves; the app only renders a chat.

## Non-goals (do not build)
Voice, streaming tokens (plain request/response first), editing/cancelling/marking-trusted from chat
(those stay in the schedule view per spec §4.2), provider-facing Handy chat, multi-language, long-term
"memory" beyond the stored chat history, any subscription/tier logic, model fine-tuning.

## Anti-goals
The model must never be able to create a booking, spend money, or touch another user's data - even if it is
manipulated by text in a provider name, a note or the customer's own message.

## Architecture (decided in discussion)
A bounded **tool-calling loop** in the backend. The LLM only handles language; matching, pricing,
availability and payment stay in the existing deterministic services (`BookingPlanService`,
`BookingService`, `CatalogService`).

1. `POST /handy/chat { message, timezone? }` (CUSTOMER, JWT).
2. Backend loads the last 20 stored messages, builds the system prompt (Handy personality + current date/time
   in the customer's timezone + their name and postcode), calls the LLM with the tool list.
3. If the LLM asks for tools, the backend runs them **as the logged-in user** (`req.user.id`, never a model
   argument) and feeds results back; max 5 rounds, then a fixed apology reply.
4. The final text is stored and returned with the latest plan card, if one was proposed.

## Decisions (my calls - not yet user-approved)
1. **Provider:** OpenAI, as the spec says; model from env `OPENAI_MODEL` (default `gpt-4o`). Only
   `LlmService` touches the SDK (same shape as `StripeService`), so switching vendors is one file.
2. **Tools the model gets (read-only or propose-only):** `list_services` (catalog),
   `propose_plan(subServiceId, scheduledAt, notes?)` (wraps `BookingPlanService.planBooking`),
   `get_my_bookings(status?)` (the customer's own bookings, projected: no provider internals).
   **There is no `create_booking` tool.**
3. **Confirmation is a separate endpoint, not a model action.** `propose_plan` stores the plan server-side
   (cache key `handy_plan:<userId>:<planId>`, 30 min TTL) and the response carries `planId`. The app's Confirm
   button calls `POST /handy/plans/:planId/confirm`, which creates the booking via
   `BookingService.createBooking(req.user.id, ...)` and returns `{ booking, checkoutUrl }`. A plan is single-use,
   only usable by the user it was made for, and 404 once expired/used. Adjust = the customer just types
   ("make it 3pm") and the model proposes a new plan; Cancel = ignore it.
4. **History:** table `handy_messages` (`userId`, `role` USER|ASSISTANT, `content`, `createdAt`); only
   user-visible text is stored, not tool traffic. `GET /handy/chat?limit=` returns it (default 50, max 100)
   oldest-first so the app can render the chat on open. Confirm appends an assistant line ("Your booking is
   reserved - complete the payment to confirm.").
5. **Usage threshold (spec §3):** `HANDY_CHAT_LIMIT` messages (default 30) per `HANDY_CHAT_WINDOW_SECONDS`
   (default 3600) per user, counted with `RedisService.incrementWithExpiry` -> **429**
   (`'You are chatting too fast, please try again shortly!'`).
6. **Dates:** the client sends an IANA `timezone` (optional, default `UTC`; invalid -> 400). The prompt states
   "now" in that timezone and tells the model to always pass `scheduledAt` as a full ISO-8601 instant with
   offset. Availability matching stays UTC (existing known gap).
7. **Failures:** no `OPENAI_API_KEY` -> 503 `'Handy is not configured!'`; any LLM/network error -> 502
   `'Handy is unavailable, please retry!'` and the real error is logged. The user's message is stored only
   when a reply was produced (a failed turn leaves no orphan).
8. **Message length:** 1-1000 characters, trimmed (same as messaging).
9. **Prompt injection stance:** tool arguments are validated (UUID, ISO date) before running; tool results
   carry only the fields the model needs; provider-supplied text (name, bio) is data inside tool results.
   Safety does not rely on the model behaving - it relies on the tool set above having no dangerous verbs.

## Data (one migration)
`handy_messages`: `id` uuid PK, `userId` uuid FK -> users `ON DELETE CASCADE`, `role` enum
(`USER`,`ASSISTANT`), `content` text, `createdAt` timestamptz default now; index `(userId, createdAt)`.

## API (prefix `api/v1`, JWT + `CUSTOMER` role)
- `POST /handy/chat` -> `{ reply: string, plan?: PlanCard }`
  `PlanCard = { planId, provider: { id, fullName, bio }, subService: { id, name }, scheduledAt, durationMinutes, priceCents, isTrustedProvider, expiresAt }`
- `GET /handy/chat?limit=` -> `{ messages: { id, role, content, createdAt }[] }`
- `POST /handy/plans/:planId/confirm` -> `{ booking, checkoutUrl }` (same shape as `POST /bookings`).

## Config
`OPENAI_API_KEY` (arrives later, on demand - the module is built and fully unit-tested against a fake
`LlmService` now), `OPENAI_MODEL`, `HANDY_CHAT_LIMIT`, `HANDY_CHAT_WINDOW_SECONDS`.

## Known gaps (record in CLAUDE.md when built)
Quality of extraction/personality is only verifiable with a real key (needs a small manual script of
sample conversations); the model can still mis-read a date, which is why the plan card shows the exact
time before Confirm; no streaming; per-message not per-token cost control; no moderation of customer text;
availability still UTC-only; a customer with no postcode gets a "add your postcode" reply because
`BookingPlanService` requires it.
