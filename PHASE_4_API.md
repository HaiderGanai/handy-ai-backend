# Phase 4 — API Reference (Postman-style)

**Base URL:** `http://localhost:3000/api/v1`

Postman variables: `baseUrl`, `customerToken`, `providerToken`, `adminToken`,
`subServiceId`, `providerId` (the provider's **provider id**, not user id), `bookingId`.
Importable version: `postman/Handy-AI.postman_collection.json` → folders **Booking** and
**Admin → Bookings**.

Conventions
- Every endpoint needs `Authorization: Bearer <token>`. Wrong role = **403**
  (`"Forbidden resource"`); missing/expired token = **401**.
- All bodies are JSON. POST returns **201**, GET/PATCH/DELETE return 200.
- Errors have one shape (global exception filter):
  `{ "statusCode", "error", "message", "path", "timestamp" }`. Validation errors have
  `message` as an array of strings.
- Dates are ISO-8601 strings (`"2030-01-07T10:00:00.000Z"`). Prices are **cents** (USD).

## Before you can book — setup checklist

1. **Customer:** sign up/in (see `PHASE_1_API.md`) and set a **postcode** — planning fails
   with 400 without one:
   `PATCH /user/profile` → `{ "postcode": "SW1A 1AA", "householdNotes": "Key under the mat" }`
2. **Provider:** onboarded (`POST /provider/onboarding`) and **approved by an admin**
   (`PHASE_3_API.md`). Only `APPROVED` providers are matched.
3. Copy a sub-service `id` from `GET /service-categories` into `subServiceId`.

**Matching rules (read this when a plan returns 404):** a provider is matched only if
- they are `APPROVED` and offer the sub-service's **category**;
- one of their `postcodeCoverage` entries **equals the customer's postcode** (case and
  spaces ignored: `sw1a1aa` = `SW1A 1AA`). There is no prefix matching — a coverage entry of
  `SW1` will **not** match `SW1A 1AA`. Put the full postcodes you want to serve in coverage;
- the whole job fits inside one of their weekly availability windows, compared in **UTC**;
- they have no other `PENDING_PROVIDER` / `CONFIRMED` / `IN_PROGRESS` booking overlapping the
  slot (back-to-back is fine).

---

## Customer

### 1. POST `{{baseUrl}}/bookings/plan`
Role: `CUSTOMER`. Stateless — nothing is saved. Returns the single best provider; the
customer's trusted provider is tried first.

Body
```json
{
  "subServiceId": "{{subServiceId}}",
  "scheduledAt": "2030-01-07T10:00:00.000Z",
  "notes": "Please bring ladders"
}
```
`notes` optional (max 1000).

| Status | Body |
|---|---|
| **201** | `{ "provider": { "id", "fullName", "bio" }, "subService": { "id", "name" }, "scheduledAt", "durationMinutes": 120, "priceCents": 8000, "isTrustedProvider": false }` |
| 400 | no postcode on profile (`"Add a postcode to your profile first!"`), time in the past, bad body |
| 404 | unknown sub-service, or `"No provider available for that time!"` |

### 2. POST `{{baseUrl}}/bookings`
Role: `CUSTOMER`. Confirms a plan. The server re-checks eligibility and takes price and
duration from the catalog — whatever the client sends for those is ignored. Status starts as
`PENDING_PROVIDER`; the provider is notified.

Body
```json
{
  "subServiceId": "{{subServiceId}}",
  "scheduledAt": "2030-01-07T10:00:00.000Z",
  "providerId": "{{providerId}}",
  "notes": "Please bring ladders"
}
```

| Status | Body |
|---|---|
| **201** | the booking: `{ "id", "userId", "providerId", "subServiceId", "scheduledAt", "durationMinutes", "priceCents", "status": "PENDING_PROVIDER", "notes", "createdAt", "updatedAt" }` |
| 400 | no postcode, time in the past, bad body |
| 404 | provider or sub-service not found |
| 409 | `"Provider is not available for that time!"` (not eligible, or slot taken) |

### 3. GET `{{baseUrl}}/bookings`
Roles: `CUSTOMER` (own bookings) and `PROVIDER` (own jobs — the inbox). Sorted by
`scheduledAt`. Optional query `?status=PENDING_PROVIDER` (any status value).
Returns **200** `[ booking + subService ]`.

**Bookings that are `IN_PROGRESS` are not in this list** — they live in
`GET /bookings/in-progress` (next) and reappear here as `COMPLETED` once the job is
finished. An explicit `?status=IN_PROGRESS` still returns them.

### 3b. GET `{{baseUrl}}/bookings/in-progress`
Roles: `CUSTOMER` and `PROVIDER`, same scoping as above (a customer's own bookings, a
provider's own jobs). No body, no query. Returns **200** `[ booking + subService ]` — only
bookings whose status is `IN_PROGRESS` (the provider has pressed *start* and not yet
*complete*), sorted by `scheduledAt`. Empty array when none.

### 4. GET `{{baseUrl}}/bookings/{{bookingId}}`
Roles: `CUSTOMER` (owner), `PROVIDER` (assigned provider), `ADMIN`. Anyone else gets **404**.
`provider` is always a small projection (`id`, `fullName`, `bio`) — never the raw provider
record. The **assigned provider** additionally gets `householdNotes` and a `customer` object
with the job `fullName` and `address` (both read live from the customer's profile); the
customer and admin responses do not include those two keys. Email/phone are never returned.

**200** (as the assigned provider)
```json
{
  "id": "…", "status": "CONFIRMED", "scheduledAt": "…", "durationMinutes": 120, "priceCents": 8000,
  "provider": { "id": "…", "fullName": "Alex Plumber", "bio": "…" },
  "subService": { "id": "…", "name": "Regular home clean" },
  "householdNotes": "Key under the mat",
  "customer": { "fullName": "Sam Customer", "address": "1 High St" }
}
```

### 5. PATCH `{{baseUrl}}/bookings/{{bookingId}}`
Role: `CUSTOMER` (owner). Only while `PENDING_PROVIDER` or `CONFIRMED`; otherwise **409**.

Body (both fields optional)
```json
{
  "scheduledAt": "2030-01-07T14:00:00.000Z",
  "notes": "Gate code 1234"
}
```
- Notes only → status unchanged.
- A **different** `scheduledAt` → the same provider is re-validated (**409** if they no longer
  fit; no auto-rematch) and the status resets to `PENDING_PROVIDER` so they re-accept.

**200** the updated booking. 404 if not yours.

### 6. DELETE `{{baseUrl}}/bookings/{{bookingId}}`
Role: `CUSTOMER` (owner). Soft cancel → `status: "CANCELLED"` (the row stays). Only from
`PENDING_PROVIDER` / `CONFIRMED`; **409** once started, completed, declined or cancelled.
**200** the booking.

### 7. POST `{{baseUrl}}/user/trusted-providers/{{providerId}}`
Role: `CUSTOMER`. No body. Marks a provider trusted — allowed only if the customer has a
`COMPLETED` booking with them. Idempotent.

| Status | Body |
|---|---|
| **201** | `{ "message": "Provider marked as trusted!" }` |
| 403 | `"You can only trust a provider after a completed job!"` |

Future plans prefer this provider whenever they are eligible (`isTrustedProvider: true`).

---

## Provider (token = `providerToken`, role `PROVIDER`)
No bodies. `:id` is the booking id; only the booking's assigned provider can act, anyone else
gets **404**; a wrong current status gets **409** (`"Booking is X, expected Y!"`). Each call
returns **201** + the booking, and notifies the customer. A provider an admin has **disabled**
gets **403** (`"Your provider account is not active!"`) on `accept` and `start` (they can still
`decline` or `complete` work already on their plate).

Every status change is a compare-and-set: if another request (the customer cancelling, an admin
reassigning) changed the booking a moment earlier, the call fails with **409**
`"Booking was just changed by someone else, please retry!"` instead of overwriting it.

| Endpoint | From → To |
|---|---|
| POST `{{baseUrl}}/bookings/{{bookingId}}/accept` | `PENDING_PROVIDER` → `CONFIRMED` |
| POST `{{baseUrl}}/bookings/{{bookingId}}/decline` | `PENDING_PROVIDER` → `DECLINED` |
| POST `{{baseUrl}}/bookings/{{bookingId}}/start` | `CONFIRMED` → `IN_PROGRESS` |
| POST `{{baseUrl}}/bookings/{{bookingId}}/complete` | `IN_PROGRESS` → `COMPLETED` |

`complete` is where Phase 5 will capture the held payment.

---

## Admin (token = `adminToken`, role `ADMIN`)

### 8. GET `{{baseUrl}}/admin/bookings`
All bookings, sorted by `scheduledAt`; optional `?status=`. **200** `[ booking + subService ]`.

### 9. POST `{{baseUrl}}/admin/bookings/{{bookingId}}/reassign`
Moves a booking to another provider (e.g. the original cancelled). Allowed only from
`PENDING_PROVIDER` / `CONFIRMED`. The new provider must pass the same eligibility check
(ignoring this booking's own slot). The booking goes back to `PENDING_PROVIDER` for the new
provider to accept; the new provider and the customer are notified.

Body
```json
{ "providerId": "{{providerId}}" }
```

| Status | Body |
|---|---|
| **201** | the booking with the new `providerId`, `status: "PENDING_PROVIDER"` |
| 404 | booking or provider not found |
| 409 | booking not reassignable (`"Only pending or confirmed bookings can be reassigned!"`) or new provider not eligible |

---

## State diagram

```
 POST /bookings
      │
      ▼
PENDING_PROVIDER ──decline──▶ DECLINED
   │   ▲     │
accept │     └── cancel ──▶ CANCELLED
   │   └── (time edit / admin reassign resets to here)
   ▼
CONFIRMED ──cancel──▶ CANCELLED
   │
 start
   ▼
IN_PROGRESS ──complete──▶ COMPLETED ──▶ customer can mark provider trusted
```

## Recommended run order
Customer: set postcode → Plan → Create → *(provider)* Accept → Start *(booking moves to
`GET /bookings/in-progress`)* → Complete *(back into `GET /bookings`)* → *(customer)*
Mark trusted → Plan again (see `isTrustedProvider: true`). Then try Edit / Cancel on a second
booking, and Admin List / Reassign.
