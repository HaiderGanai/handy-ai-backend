# Phase 1 — API Reference (Postman-style)

**Base URL:** `http://localhost:3000/api/v1`

Postman variables: `baseUrl` = `http://localhost:3000/api/v1`, `accessToken`,
`resetToken`. Importable version: `postman/Handy-AI.postman_collection.json`.

Conventions
- All bodies are JSON (`Content-Type: application/json`) unless noted.
- Protected endpoints need header `Authorization: Bearer {{accessToken}}`.
- POST endpoints return **201** on success (Nest default); GET/PATCH return 200.
- Error shape: `{ "message": ..., "error": "...", "statusCode": N }`. Validation
  errors have `message` as an array of strings.
- OTP codes are 5 digits; during local dev read them from Mailpit
  (`http://localhost:8025`) or the SMTP inbox.
- Example user below: `jane@example.com` / `password123`.

Recommended run order: Health → Sign Up → Verify OTP (SIGNUP) → Sign In → Profile
requests → Logout → Forgot Password → Verify OTP (RESET_PASSWORD) → Reset Password.

---

## Health

### GET `{{baseUrl}}/health`
No auth, no body.

**200 OK**
```json
{ "status": "ok" }
```

---

## Auth

### 1. POST `{{baseUrl}}/auth/sign-up`
Creates an unverified account and emails a 5-digit OTP (valid 10 min).

Body
```json
{
  "email": "jane@example.com",
  "password": "password123",
  "fullName": "Jane Doe"
}
```
Rules: valid email, password ≥ 8 chars, fullName string.

Optional `"role": "PROVIDER"` (added in Phase 3) creates a provider account; omitted =
`CUSTOMER`. `ADMIN` is rejected (400 `role must be one of the following values: CUSTOMER, PROVIDER`).
The role is fixed at sign-up and travels in the JWT. See `PHASE_3_API.md`.

| Status | Body |
|---|---|
| **201** | `{ "message": "Verification code sent to your email!" }` |
| 409 | `{ "message": "User Already Exists!", "error": "Conflict", "statusCode": 409 }` |
| 400 | `{ "message": ["email must be an email"], "error": "Bad Request", "statusCode": 400 }` (also: `password must be longer than or equal to 8 characters`) |

---

### 2. POST `{{baseUrl}}/auth/verify-otp` — purpose `SIGNUP`
Body
```json
{
  "email": "jane@example.com",
  "code": "12345",
  "purpose": "SIGNUP"
}
```
Rules: `code` exactly 5 chars; `purpose` is `SIGNUP` or `RESET_PASSWORD`.
Max 5 attempts per 15 min per email.

| Status | Body |
|---|---|
| **201** | `{ "message": "Email verified successfully!" }` |
| 400 | `{ "message": "Invalid or Expired OTP!", "error": "Bad Request", "statusCode": 400 }` |
| 400 | `{ "message": "Too many attempts. Please request a new code!", "error": "Bad Request", "statusCode": 400 }` |

---

### 3. POST `{{baseUrl}}/auth/resend-otp`
Body
```json
{
  "email": "jane@example.com",
  "purpose": "SIGNUP"
}
```
Always the same answer (no account enumeration). A new code replaces the old one and
resets the attempt counter.

| Status | Body |
|---|---|
| **201** | `{ "message": "If an account exists, a verification code has been sent!" }` |
| 400 | validation error (bad email / purpose) |

---

### 4. POST `{{baseUrl}}/auth/sign-in`
For customers and providers. Admin accounts get 401 here; they use `POST /admin/auth/sign-in` (`PHASE_3_API.md`).

Body
```json
{
  "email": "jane@example.com",
  "password": "password123"
}
```
Starts a session and retires any previous one for this user.
**Postman test script** to store the token:
```js
pm.collectionVariables.set("accessToken", pm.response.json().accessToken);
```

| Status | Body |
|---|---|
| **201** | see below |
| 401 | `{ "message": "Invalid credentials!", "error": "Unauthorized", "statusCode": 401 }` (unknown email **or** wrong password) |
| 403 | `{ "message": "Please verify your email first!", "error": "Forbidden", "statusCode": 403 }` |

**201 body**
```json
{
  "user": {
    "id": "8f046014-901e-4794-8e89-310a90b18349",
    "email": "jane@example.com",
    "role": "CUSTOMER",
    "isEmailVerified": true,
    "fullName": "Jane Doe",
    "address": null,
    "postcode": null,
    "photoUrl": null,
    "householdNotes": null,
    "createdAt": "2026-10-06T13:30:00.000Z",
    "updatedAt": "2026-10-06T13:31:00.000Z"
  },
  "accessToken": "<jwt>"
}
```
`password`, OTP and reset-token fields never appear in responses.

---

### 5. POST `{{baseUrl}}/auth/forgot-password`
Body
```json
{ "email": "jane@example.com" }
```
| Status | Body |
|---|---|
| **201** | `{ "message": "If an account exists, a verification code has been sent!" }` (same for unknown emails) |
| 400 | validation error |

---

### 6. POST `{{baseUrl}}/auth/verify-otp` — purpose `RESET_PASSWORD`
Body
```json
{
  "email": "jane@example.com",
  "code": "12345",
  "purpose": "RESET_PASSWORD"
}
```
**Postman test script**
```js
pm.collectionVariables.set("resetToken", pm.response.json().resetToken);
```
| Status | Body |
|---|---|
| **201** | `{ "message": "OTP verified!", "resetToken": "f8ba460d…b86923" }` (64 hex chars, valid 15 min, single use) |
| 400 | `Invalid or Expired OTP!` / `Too many attempts. Please request a new code!` |

---

### 7. POST `{{baseUrl}}/auth/reset-password`
Body
```json
{
  "resetToken": "{{resetToken}}",
  "newPassword": "newpassword456"
}
```
Rules: newPassword ≥ 8 chars. Also logs the user out everywhere.

| Status | Body |
|---|---|
| **201** | `{ "message": "Password reset successfully!" }` |
| 400 | `{ "message": "Invalid or Expired Reset Token!", "error": "Bad Request", "statusCode": 400 }` |
| 400 | validation error (short password) |

---

### 8. POST `{{baseUrl}}/auth/logout`  🔒
Header: `Authorization: Bearer {{accessToken}}` — no body.

| Status | Body |
|---|---|
| **201** | `{ "message": "Logged out successfully!" }` |
| 401 | `{ "message": "Unauthorized", "statusCode": 401 }` (no/invalid/expired token) |
| 401 | `{ "message": "Session expired. Please sign in again!", "error": "Unauthorized", "statusCode": 401 }` (token already logged out / replaced by a newer sign-in) |

After logout the same token is rejected on every protected route.

---

## User (all 🔒 — header `Authorization: Bearer {{accessToken}}`)

### 9. GET `{{baseUrl}}/user/profile`
No body.

| Status | Body |
|---|---|
| **200** | the user object (same shape as sign-in `user`) |
| 401 | `Unauthorized` / `Session expired. Please sign in again!` |
| 404 | `{ "message": "User not found!" }` (token valid but user deleted) |

```json
{
  "id": "8f046014-901e-4794-8e89-310a90b18349",
  "email": "jane@example.com",
  "role": "CUSTOMER",
  "isEmailVerified": true,
  "fullName": "Jane Doe",
  "address": null,
  "postcode": null,
  "photoUrl": null,
  "householdNotes": null,
  "createdAt": "2026-10-06T13:30:00.000Z",
  "updatedAt": "2026-10-06T13:31:00.000Z"
}
```

---

### 10. PATCH `{{baseUrl}}/user/profile`
Partial update — send only the fields to change; omitted fields keep their values.
Body
```json
{
  "address": "221B Baker Street",
  "postcode": "NW1 6XE",
  "householdNotes": "Key under the mat, code 4321"
}
```
Allowed fields: `fullName`, `address`, `postcode`, `householdNotes` (all strings).
Anything else (`email`, `role`, `password`…) is ignored.

| Status | Body |
|---|---|
| **200** | updated user object, e.g. `address: "221B Baker Street"`, `postcode: "NW1 6XE"`, `householdNotes: "Key under the mat, code 4321"`, `fullName` unchanged |
| 400 | validation error (e.g. `postcode must be a string`) |
| 401 | `Unauthorized` / `Session expired…` |

---

### 11. POST `{{baseUrl}}/user/profile/photo`
Body type: **form-data** (not JSON). One field: key `photo`, type **File** (an image).
Uploads to Cloudinary folder `handy-ai/avatars`.

| Status | Body |
|---|---|
| **200** | updated user object with `"photoUrl": "https://res.cloudinary.com/.../handy-ai/avatars/<id>.jpg"` |
| 401 | `Unauthorized` / `Session expired…` |
| 500 | `{ "statusCode": 500, "message": "Internal server error" }` — while `CLOUDINARY_*` keys are still blank |

---

## Quick scenario checks

| Scenario | Expected |
|---|---|
| Sign in before verifying | 403 `Please verify your email first!` |
| 6th wrong OTP within 15 min | 400 `Too many attempts…` until a new code is requested |
| Sign in twice, use the first token | 401 `Session expired…` (single active session) |
| Use token after logout | 401 `Session expired…` |
| Reset password, then use old token | 401 `Session expired…` |
| Reuse the same reset token | 400 `Invalid or Expired Reset Token!` |
| PATCH with only `{"postcode":"X"}` | 200, other profile fields unchanged |
