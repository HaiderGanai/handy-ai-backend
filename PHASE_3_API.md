# Phase 3 — API Reference (Postman-style)

**Base URL:** `http://localhost:3000/api/v1`

Postman variables: `baseUrl`, `accessToken` (provider), `adminToken`, `providerId`,
`categoryId`. Importable version: `postman/Handy-AI.postman_collection.json` under
**Provider** and **Admin**.

Conventions
- Every endpoint here needs `Authorization: Bearer <token>`. Provider endpoints need a
  `PROVIDER` token, admin endpoints an `ADMIN` token. Wrong role = **403**
  `{ "message": "Forbidden resource", "error": "Forbidden", "statusCode": 403 }`;
  missing/expired token = **401**.
- Bodies are JSON except `POST /provider/documents` (multipart form-data).
- POST returns **201**, GET/PATCH/DELETE return 200.
- Error shape and validation errors are the same as Phase 1.

## How to get a provider and an admin account

**Provider:**
1. `POST /auth/sign-up` with `"role": "PROVIDER"` (see `PHASE_1_API.md`)
2. `POST /auth/verify-otp` with `purpose: "SIGNUP"` and the emailed code
3. `POST /auth/sign-in` — response has `accessToken` and `user.role = "PROVIDER"`
4. `POST /provider/onboarding`, then `POST /provider/documents`; wait for an admin.

**Admin:** there is no sign-up for admins. Create the account directly in the database
(`role = 'ADMIN'`, `isEmailVerified = true`, bcrypt-hashed password), or promote an existing
user with `UPDATE users SET role = 'ADMIN' WHERE email = '...'` and have them sign in again
(the role is stored in the JWT). Admins sign in only through `POST /admin/auth/sign-in` (below).

Recommended run order: Sign Up (PROVIDER) → Verify OTP → Sign In → Get Service
Categories (copy a category `id`) → Onboarding → Upload Documents → *(as admin)* List →
Approve / Reject → Disable → Delete.

---

## Provider

### 1. POST `{{baseUrl}}/provider/onboarding`
Creates the provider profile for the signed-in provider. One per user.

Body
```json
{
  "bio": "10 years of plumbing experience",
  "postcodeCoverage": ["SW1", "SW3"],
  "categoryIds": ["{{categoryId}}"],
  "availability": [
    { "dayOfWeek": 1, "startTime": "09:00", "endTime": "17:00" }
  ]
}
```
Rules
- `bio`: string. `postcodeCoverage`: non-empty array of strings (plain list, no radius maths).
- `categoryIds`: non-empty array of service-category uuids from `GET /service-categories`.
- `availability`: non-empty; `dayOfWeek` 0 (Sunday) to 6, times `HH:mm`, start before end.

| Status | Body |
|---|---|
| **201** | the provider (below), `status: "PENDING"` (no `documents` key yet) |
| 409 | `{ "message": "Provider profile already exists!", "error": "Conflict", "statusCode": 409 }` |
| 400 | validation errors, `One or more service categories are invalid!`, or `Availability start time must be before end time!` |
| 403 | caller is not a `PROVIDER` |

**201 Created**
```json
{
  "id": "<provider uuid>",
  "userId": "<user uuid>",
  "bio": "10 years of plumbing experience",
  "postcodeCoverage": ["SW1", "SW3"],
  "status": "PENDING",
  "rejectionReason": null,
  "stripeAccountId": null,
  "categories": [{ "id": "<uuid>", "name": "Cleaning", "slug": "cleaning", "sortOrder": 0 }],
  "availability": [
    { "id": "<uuid>", "dayOfWeek": 1, "startTime": "09:00", "endTime": "17:00" }
  ],
  "createdAt": "2026-10-09T12:11:49.600Z",
  "updatedAt": "2026-10-09T12:11:49.600Z"
}
```

---

### 2. GET `{{baseUrl}}/provider/profile`
No body. Returns the signed-in provider's profile with `categories`, `availability` and
`documents`. Time values come back as `HH:mm:ss` (e.g. `"09:00:00"`).

| Status | Body |
|---|---|
| **200** | provider (same shape as above plus `documents`) |
| 404 | `{ "message": "Provider profile not found!", ... }` (not onboarded yet) |

`documents` item
```json
{
  "id": "<uuid>",
  "type": "GOVERNMENT_ID",
  "fileUrl": "https://res.cloudinary.com/.../handy-ai/provider-documents/<provider id>/...",
  "status": "PENDING",
  "createdAt": "2026-10-09T12:20:00.000Z"
}
```

---

### 3. PATCH `{{baseUrl}}/provider/profile`
Send any subset of the onboarding fields; omitted fields are left alone. `categoryIds` and
`availability` **replace** the previous values (they are not merged). `status` cannot be
changed here.

Body (example: change only availability)
```json
{ "availability": [{ "dayOfWeek": 2, "startTime": "10:00", "endTime": "12:00" }] }
```

| Status | Body |
|---|---|
| **200** | updated provider (with `documents`) |
| 404 | provider profile not found |
| 400 | same validation errors as onboarding |

---

### 4. POST `{{baseUrl}}/provider/documents`
Uploads 1 to 5 vetting documents in one request. **Body = form-data** (not raw JSON). Add
one row per file: the **key is the document type**, the value type is **File**.

| KEY (type: File) | Document |
|---|---|
| `GOVERNMENT_ID` | government-issued ID |
| `RIGHT_TO_WORK` | right-to-work proof |
| `LIABILITY_INSURANCE` | liability insurance |
| `REFERENCE` | reference |
| `PROFILE_PHOTO` | profile photo |

There is no separate `type` field. Send any subset (1 to 5 rows, one file per key) — you can
upload some now and the rest later.

Rules
- Allowed: JPEG, PNG, PDF. Max 5 MB per file.
- If any file is invalid, **nothing** is uploaded.
- Uploading a type that already exists **replaces** it and sets it back to `PENDING`.
- A `REJECTED` provider who uploads again goes back to `PENDING` (back in the admin queue).
- Files are stored on Cloudinary (needs the `CLOUDINARY_*` env keys; without them → 500).

| Status | Body |
|---|---|
| **201** | array of the saved documents (one per file sent), each `status: "PENDING"` |
| 400 | `Unexpected file field - <key>` (key isn't one of the 5 types), `At least one document file is required!`, or `Only JPEG, PNG or PDF files are allowed!` |
| 413 | `File too large` (over 5 MB) |
| 404 | `Provider profile not found!` (onboard first) |
| 500 | Cloudinary keys missing/invalid |

**201 Created** (two files sent)
```json
[
  {
    "id": "<uuid>",
    "type": "GOVERNMENT_ID",
    "fileUrl": "https://res.cloudinary.com/.../id.pdf",
    "status": "PENDING",
    "createdAt": "2026-10-09T12:20:00.000Z"
  },
  {
    "id": "<uuid>",
    "type": "REFERENCE",
    "fileUrl": "https://res.cloudinary.com/.../ref.pdf",
    "status": "PENDING",
    "createdAt": "2026-10-09T12:20:00.000Z"
  }
]
```

---

## Admin (`ADMIN` token)

### 0. POST `{{baseUrl}}/admin/auth/sign-in`
Admin-only login. Same body and response as `POST /auth/sign-in`, but it only accepts `ADMIN`
accounts, and `POST /auth/sign-in` in turn refuses admins. Either way, a wrong password, an
unknown email, or an account of the wrong role all return the same 401, so the response doesn't
reveal which accounts are admins.

Body
```json
{ "email": "admin@admin.com", "password": "<admin password>" }
```

| Status | Body |
|---|---|
| **201** | `{ "user": { ..., "role": "ADMIN" }, "accessToken": "<jwt>" }` |
| 401 | `{ "message": "Invalid credentials!", "error": "Unauthorized", "statusCode": 401 }` |
| 403 | `Please verify your email first!` (account not verified) |

Use the returned `accessToken` as `adminToken` in the endpoints below. Signing in replaces any
previous session for that user (single active session).

---

### 5. GET `{{baseUrl}}/admin/providers`
Optional query `?status=PENDING` (`PENDING | APPROVED | REJECTED | DISABLED`). Oldest
first. Each item is a provider with `user`, `categories`, `availability`, `documents`.

| Status | Body |
|---|---|
| **200** | array of providers (empty array if none) |
| 400 | `status must be one of the following values: ...` |

---

### 6. POST `{{baseUrl}}/admin/providers/:id/approve`
No body. `:id` is the provider id (not the user id).

Allowed from `PENDING`, or from `DISABLED` (this is how a provider is re-enabled). All 5
document types must be uploaded. Sets the provider and all its documents to `APPROVED` and
clears `rejectionReason`.

| Status | Body |
|---|---|
| **200** | the provider, `status: "APPROVED"` |
| 400 | `Provider has missing documents!`, `Provider cannot be approved!` (already approved or rejected), or `Validation failed (uuid is expected)` |
| 404 | `Provider not found!` |

---

### 7. POST `{{baseUrl}}/admin/providers/:id/reject`
Allowed only from `PENDING`. Sets the provider and all its documents to `REJECTED`.

Body (optional)
```json
{ "reason": "Government ID is blurry, please re-upload" }
```

| Status | Body |
|---|---|
| **200** | the provider, `status: "REJECTED"`, `rejectionReason` set (or `null`) |
| 400 | `Only pending providers can be rejected!` |
| 404 | `Provider not found!` |

The provider can fix things and re-upload documents (endpoint 4), which puts them back to
`PENDING`.

---

### 8. POST `{{baseUrl}}/admin/providers/:id/disable`
No body. Allowed only from `APPROVED`.

| Status | Body |
|---|---|
| **200** | the provider, `status: "DISABLED"` |
| 400 | `Only approved providers can be disabled!` |
| 404 | `Provider not found!` |

---

### 9. DELETE `{{baseUrl}}/admin/providers/:id`
Hard-deletes the provider; its documents and availability go with it. The user account
(and its `PROVIDER` role) stays, so they could onboard again.

| Status | Body |
|---|---|
| **200** | `{ "message": "Provider deleted!" }` |
| 404 | `Provider not found!` |

---

## Provider status lifecycle

```
onboarding ──▶ PENDING ──approve──▶ APPROVED ──disable──▶ DISABLED
                  │  ▲                                        │
               reject │ re-upload a document                  │
                  ▼  │                                        │
               REJECTED          approve (re-enable) ◀────────┘
```
