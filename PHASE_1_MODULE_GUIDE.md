# Phase 1 — Module Guide: What Happens Inside Auth & User

A walkthrough of how the Phase 1 code works internally: which file does what, what
gets stored where, and what happens step by step on every request. For the
request/response reference see `PHASE_1_API.md`. For the "why" behind decisions see
`PHASE_1_NOTES.md` and `CLAUDE.md`.

## 1. Big picture

```
Client ──HTTP──▶ Nest app (prefix /api/v1)
                   │
                   ├─ ValidationPipe (whitelist + transform)   ← DTO checks
                   ├─ Controller                               ← routing only
                   │    └─ AuthGuard('jwt') on protected routes
                   │          └─ JwtStrategy.validate()        ← Redis session check
                   ├─ Service                                  ← all business logic
                   │    ├─ Postgres (TypeORM): users, user_sessions
                   │    ├─ Redis: session id, OTP attempt counter
                   │    ├─ MailService (SMTP): OTP emails
                   │    └─ CloudinaryService: avatar upload
                   └─ ClassSerializerInterceptor               ← strips @Exclude() fields
```

Global setup lives in `src/main.ts`:
- prefix `api/v1`, CORS on
- `ValidationPipe({ whitelist: true, transform: true })` — unknown body fields are
  silently dropped, bodies become real DTO class instances
- `ClassSerializerInterceptor` — any `@Exclude()` field on an entity (password, OTP
  fields, reset token) is removed from every response automatically

## 2. File map

| Path | Role |
|---|---|
| `src/auth/auth.controller.ts` | 7 routes under `/auth`, delegates to `AuthService` |
| `src/auth/auth.service.ts` | Sign-up, OTP verify/resend, sign-in, forgot/reset, logout, session create/invalidate |
| `src/auth/services/auth-response.service.ts` | Builds `{ user, accessToken }`; keeps `user` a `User` instance so `@Exclude()` still applies |
| `src/auth/strategies/jwt.strategy.ts` | Validates bearer token **and** checks its `sid` against Redis |
| `src/auth/guards/roles.guard.ts` + `decorators/roles.decorator.ts` | Role check (`CUSTOMER`/`PROVIDER`/`ADMIN`); built now, used from Phase 3 on |
| `src/auth/dto/*.ts` | Input shapes + validation rules (6 DTOs) |
| `src/user/user.controller.ts` | `/user/profile` routes, whole controller behind the JWT guard |
| `src/user/user.service.ts` | Get / update profile, upload photo |
| `src/user/entities/user.entity.ts` | `users` table |
| `src/user/entities/user-session.entity.ts` | `user_sessions` table |
| `src/redis/redis.service.ts` | Raw Redis client; only used for atomic `INCR`+`EXPIRE` |
| `src/cache/app-cache.module.ts` | cache-manager + `@keyv/redis` (session id storage) |
| `src/common/cache-keys.ts` | Central place for Redis key names |
| `src/common/authenticated-request.ts` | Typed `req.user` (`{ id, role }`) |
| `src/mail/mail.service.ts` | nodemailer wrapper |
| `src/cloudinary/cloudinary.service.ts` | Buffer → Cloudinary upload |
| `src/database/migrations/…Phase1AuthUserCore.ts` | Creates both tables + enums |
| `src/health/health.controller.ts` | `GET /health` |

## 3. Data model

### `users`
| Column | Notes |
|---|---|
| `id` | uuid PK |
| `email` | unique, always stored trimmed + lowercase |
| `password` | bcrypt hash (cost 10) — `@Exclude()` |
| `role` | enum `CUSTOMER` (default) / `PROVIDER` / `ADMIN` |
| `isEmailVerified` | false until signup OTP is verified |
| `otpCode`, `otpExpiresAt`, `otpPurpose` | the *current* pending OTP (one at a time) — all `@Exclude()` |
| `resetToken`, `resetTokenExpiresAt` | **sha256 hash** of the reset token + expiry — `@Exclude()` |
| `fullName`, `address`, `postcode`, `photoUrl`, `householdNotes` | profile, all nullable |
| `createdAt`, `updatedAt` | automatic |

### `user_sessions`
| Column | Notes |
|---|---|
| `id` | uuid PK |
| `userId` | owner |
| `refreshTokenHash` | sha256 of the session id (`sid`). Despite the name it is not a refresh token — there is none |
| `userAgent` | from the sign-in request header |
| `createdAt`, `expiresAt` | expiry = now + `JWT_EXPIRES_IN` seconds |

### Redis keys
| Key | Value | TTL |
|---|---|---|
| `user_session:<userId>` | the active `sid` | `JWT_EXPIRES_IN` seconds |
| `otp_attempts:<email>` | failed/total verify count | 15 min, set on first increment |

## 4. Flows, step by step

### 4.1 Sign up — `POST /auth/sign-up`
1. DTO: valid email, password ≥ 8, fullName string.
2. Lowercase/trim email; if a user exists → `409 User Already Exists!`.
3. bcrypt-hash the password, save user (`isEmailVerified = false`, role `CUSTOMER`).
4. `generateAndSendOtp(user, SIGNUP)`:
   - code = `crypto.randomInt(10000, 100000)` (5 digits, cryptographically secure)
   - saved on the user row with 10-minute expiry and purpose
   - the `otp_attempts:<email>` counter is deleted (fresh code = fresh attempt budget)
   - email sent through SMTP
5. Returns a generic message. The account exists but cannot sign in yet.

### 4.2 Verify OTP — `POST /auth/verify-otp`
1. Increment `otp_attempts:<email>` atomically. If > 5 → `400 Too many attempts`.
   (This happens **before** looking at the user, so unknown emails burn attempts too.)
2. Load user; the code is valid only if code, purpose **and** expiry all match.
   Otherwise `400 Invalid or Expired OTP!` (same message for every failure reason).
3. On success the OTP fields are nulled and the attempt counter deleted (single use).
4. Branch on `purpose`:
   - `SIGNUP` → `isEmailVerified = true`, return a message.
   - `RESET_PASSWORD` → generate 32 random bytes (hex), store only its sha256 hash +
     15-minute expiry, return the **raw** token once in the response.

### 4.3 Resend OTP — `POST /auth/resend-otp`
Same response whether the email exists or not. A new code is only issued if the user
exists and (for `SIGNUP`) is not already verified. Issuing a code overwrites the
previous one and resets the attempt counter.

### 4.4 Sign in — `POST /auth/sign-in`
1. Unknown email → `401 Invalid credentials!`.
2. Not verified → `403 Please verify your email first!`.
3. bcrypt compare; mismatch → `401 Invalid credentials!`.
4. `createSession`:
   - `invalidateSessions(userId)` — deletes old DB rows and the old Redis key
     (**single active session**: a new login kicks out the previous one)
   - new `sid` = `randomUUID()`
   - JWT payload `{ sub: userId, sid, role }`, signed with `JWT_SECRET`, expiry
     `JWT_EXPIRES_IN` seconds
   - `user_sessions` row saved (sha256 of `sid`, user-agent, expiry)
   - Redis `user_session:<userId>` = `sid`
5. Response: `{ user, accessToken }` (user passed through the serializer).

### 4.5 Every protected request
`AuthGuard('jwt')` → `JwtStrategy`:
1. Extract `Authorization: Bearer <token>`; verify signature and `exp`.
2. `validate(payload)`: read `user_session:<sub>` from Redis. Missing or different
   from `payload.sid` → `401 Session expired. Please sign in again!`.
3. Attaches `req.user = { id, role }`. Controllers always use `req.user.id`, never an
   id from the URL or body — that is why there is no `/me` anywhere.

This Redis check is what makes logout real: the JWT signature is still valid after
logout, but its `sid` no longer matches anything.

### 4.6 Logout — `POST /auth/logout`
Deletes the user's `user_sessions` rows and the Redis key. The token is dead on the
very next request.

### 4.7 Forgot / reset password
1. `POST /auth/forgot-password` — generic response; if the user exists, a
   `RESET_PASSWORD` OTP is emailed.
2. `POST /auth/verify-otp` with `purpose: RESET_PASSWORD` — returns `resetToken`
   (flow 4.2).
3. `POST /auth/reset-password` — sha256 the supplied token, find the user by that
   hash, check expiry. Then: new bcrypt password, reset token cleared, **all sessions
   invalidated** (anyone holding an old token is logged out).

### 4.8 Profile — `/user/profile`
- `GET` — loads the user by `req.user.id`.
- `PATCH` — merges only fields the client actually sent. Important detail: unset DTO
  fields exist as own `undefined` properties (ES2023 class fields), so
  `UserService.updateProfile` filters out `undefined` before `Object.assign`.
  Without that, a partial update would null the other fields.
  Updatable fields: `fullName`, `address`, `postcode`, `householdNotes`.
  Not updatable (silently dropped by `whitelist`): email, role, password, etc.
- `POST /profile/photo` — multer (memory storage) reads multipart field `photo`;
  buffer is uploaded to Cloudinary folder `handy-ai/avatars`; the `secure_url` is
  stored in `photoUrl`. Needs real `CLOUDINARY_*` keys.

## 5. Security properties (and where they come from)

| Property | Mechanism |
|---|---|
| Passwords never stored/returned in plain | bcrypt + `@Exclude()` |
| Revocable JWTs | `sid` claim checked against Redis on every request |
| One device at a time | `invalidateSessions` before every new session |
| OTP brute force limited | 5 attempts / 15 min via atomic Redis `INCR` |
| OTP is single-use and short-lived | cleared on success, 10 min expiry |
| Reset token not recoverable from DB | only sha256 stored, 15 min expiry, single use |
| No account enumeration | resend/forgot return identical text; sign-in uses one message for "no user" and "bad password" |
| Mass-assignment blocked | `whitelist: true` + explicit DTOs |
| Sensitive fields never leak | `ClassSerializerInterceptor` + `@Exclude()` |

Known limits (deliberate): `sign-up` does reveal that an email is registered (409);
there is no refresh token, so a user re-signs in after `JWT_EXPIRES_IN`; no rate
limit on sign-in itself; no multi-device sessions.

## 6. Config it depends on

`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN` (seconds),
`MAIL_HOST/PORT/USER/PASS/FROM`, `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET`.

## 7. Tests

`auth.service.spec.ts` and `user.service.spec.ts` (Jest, mocked repositories) cover
happy paths and failure modes: wrong password, unverified sign-in, wrong/expired OTP,
attempt lockout, no-enumeration, bad reset token, and the partial-update regression
(using a real `UpdateProfileDto` instance). No e2e suite; endpoints were verified
live against real Postgres/Redis/Mailpit.
