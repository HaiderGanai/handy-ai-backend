# Phase 9 — API Reference (Handy AI Chat)

**Base URL:** `http://localhost:3000/api/v1`. Postman folder **Handy** (variables `customerToken`, `planId`).
All three routes are `CUSTOMER` only (providers get 403). Same conventions as `PHASE_4_API.md`.

The customer never calls booking APIs: the app shows a chat, sends what the customer types to
`POST /handy/chat`, renders `reply`, and when a `plan` comes back shows a plan card with **Confirm**.
Confirm calls `POST /handy/plans/:planId/confirm`; the app then opens `checkoutUrl` (Stripe Checkout).
The model can propose a plan but can never create a booking.

## 1. POST `{{baseUrl}}/handy/chat`
```json
{ "message": "Can someone clean my flat tomorrow morning?", "timezone": "Asia/Karachi" }
```
`message` is trimmed, 1–1000 characters. `timezone` is an optional IANA name (default `UTC`).

Response `201`:
```json
{
  "reply": "Marcus is free tomorrow at 10:00 for a 2-hour regular clean, $80. Shall I go ahead?",
  "plan": {
    "planId": "7d1c…",
    "provider": { "id": "…", "fullName": "Marcus Reed", "bio": "10 years of cleaning experience" },
    "subService": { "id": "…", "name": "Regular home clean" },
    "scheduledAt": "2030-03-06T10:00:00.000Z",
    "durationMinutes": 120,
    "priceCents": 8000,
    "isTrustedProvider": false,
    "expiresAt": "2030-03-05T12:30:00.000Z"
  }
}
```
`plan` is present only when this turn proposed one (the latest, if several). The reply never claims a
booking is made. Typing "make it 3pm" simply produces a new plan; ignoring the card cancels it.

| Status | When |
|---|---|
| 400 | blank/oversized message, invalid timezone |
| 403 | not a customer |
| 429 | `You are chatting too fast, please try again shortly!` (default 30 messages per hour per user) |
| 502 | `Handy is unavailable, please retry!` (the model call failed; nothing is stored) |
| 503 | `Handy is not configured!` (`OPENAI_API_KEY` or `OPENAI_MODEL` not set) |

## 2. GET `{{baseUrl}}/handy/chat?limit=50`
Stored conversation, **oldest first**, for rendering the chat on open. `limit` 1–100, default 50.
```json
{ "messages": [ { "id": "…", "role": "USER", "content": "…", "createdAt": "…" }, { "id": "…", "role": "ASSISTANT", "content": "…", "createdAt": "…" } ] }
```

## 3. POST `{{baseUrl}}/handy/plans/{{planId}}/confirm`
No body. Books the stored plan as the logged-in customer and returns the same shape as `POST /bookings`:
```json
{ "booking": { "id": "…", "status": "PENDING_PAYMENT", "…": "…" }, "checkoutUrl": "https://checkout.stripe.com/…" }
```
The plan is single-use and expires after 30 minutes. A confirmation line is also added to the chat history.

| Status | When |
|---|---|
| 400 | `planId` is not a UUID |
| 404 | `Plan not found or expired!` (unknown, expired, already confirmed, or another user's plan) |
| 409 / 400 | the booking itself was refused (slot taken meanwhile, time now outside the 7-day window…); the plan is kept so the customer can ask for another time |
