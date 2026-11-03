# Phase 6 — API Reference (In-App Messaging)

**Base URL:** `http://localhost:3000/api/v1`. Postman folder **Messaging** (variables `customerToken`,
`providerToken`, `bookingId`, `messageId`). Same conventions as `PHASE_4_API.md`: Bearer token, error
shape `{ statusCode, error, message, path, timestamp }`.

One thread per booking, between the booking's customer and its assigned provider. Roles: `CUSTOMER`
and `PROVIDER` only. Delivery is polling.

## 1. POST `{{baseUrl}}/bookings/{{bookingId}}/messages`
Body (trimmed, 1–1000 characters):
```json
{ "body": "Running 10 minutes late, sorry" }
```
Response `201`:
```json
{
  "id": "81cd5cbd-7b47-4b79-976a-0e8b84f0df4f",
  "bookingId": "846899b3-13e0-4177-ae39-aff4d948de47",
  "senderId": "b13f46f5-78a0-42bd-9d70-d596bbe7a589",
  "sender": "CUSTOMER",
  "body": "Running 10 minutes late, sorry",
  "createdAt": "2026-11-03T12:44:09.795Z"
}
```
`sender` is `CUSTOMER` or `PROVIDER`. No email, phone or address of either party is ever returned.

Writing is allowed only while the booking is `PENDING_PROVIDER`, `CONFIRMED` or `IN_PROGRESS`.

| Status | When |
|---|---|
| 400 | empty/whitespace body, body over 1000 chars, bad booking id |
| 403 | wrong role (admins are blocked by the role guard) |
| 404 | not this booking's customer or assigned provider; provider on a `PENDING_PAYMENT` booking |
| 409 | `Messaging is closed for this booking!` (`PENDING_PAYMENT`, `DECLINED`, `CANCELLED`, `COMPLETED`) |

The other party is sent a `MESSAGE_RECEIVED` notification (`{ bookingId }`, never the text) — log-only until Phase 7.

## 2. GET `{{baseUrl}}/bookings/{{bookingId}}/messages`
Query (all optional): `after` (a message id), `limit` (1–100, default 50).
Response `200`, **oldest first**:
```json
{ "messages": [ { "id": "…", "bookingId": "…", "senderId": "…", "sender": "PROVIDER", "body": "No problem!", "createdAt": "…" } ] }
```
- No `after`: the latest `limit` messages (the first load).
- `after=<id of the last message you have>`: only messages newer than it. Poll with this.
- Works in every booking status, so history stays readable after completion or cancellation.

| Status | When |
|---|---|
| 400 | `after` is not a message of this booking (`Unknown message cursor!`), `limit` out of range |
| 404 | same as sending |
