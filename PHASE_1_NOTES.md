# Phase 1 — Auth & User Profile — What's Happening

Companion to `PLAN.md` (the roadmap) and `CLAUDE.md` (living context). This one
explains what Phase 1 actually built, how the pieces fit together, and how to try it
yourself. Postman collection: `postman/Handy-AI.postman_collection.json`.

## What this phase delivers

Email-based sign-up/sign-in with OTP verification, forgot/reset password, logout, and
a guarded user profile (read/update/photo upload). No phone OTP, no SendGrid, no
AI/OpenAI — all explicitly deferred per `CLAUDE.md`.

## The sign-up → verified account flow

1. `POST /auth/sign-up` — email + password + full name. Creates the user row
   (unverified), generates a 5-digit OTP (`crypto.randomInt`, never `Math.random`),
   emails it, and returns a generic "code sent" message.
2. `POST /auth/verify-otp` with `purpose: SIGNUP` — checks the code against what's
   stored on the user row, with an attempt cap (see below). On success, marks the
   account verified and clears the OTP fields immediately.
3. `POST /auth/sign-in` — only works once verified. Wrong password or unverified
   account both fail with the right HTTP status (401 / 403).
4. Didn't get the code? `POST /auth/resend-otp` re-issues one. Same response whether
   or not the email is registered — no account enumeration.

## Sessions: how logout actually invalidates a JWT

A plain JWT can't be revoked before it expires — the signature is still valid even
after logout. This project closes that gap with a thin session layer:

- On sign-in, a random `sid` (session id) is embedded in the JWT payload alongside
  the user id and role.
- That same `sid` is cached in Redis under `user_session:<userId>` (TTL = token
  expiry) and written to a `user_sessions` Postgres row (hash of the `sid`, not the
  token itself).
- Every authenticated request's JWT strategy checks the token's `sid` against what's
  currently cached for that user. Mismatch or missing → `401 Session expired`.
- **Logout** deletes both the Redis key and the DB row — the token is dead
  immediately, not just logically.
- **Signing in again** also deletes the previous session first — this is a
  single-active-session model (one login at a time per user). Multi-device support
  isn't built; it wasn't asked for, and the cache key scheme (one key per user, not
  per user+device) would need to change to add it.

## Forgot / reset password

Same OTP mechanism, `purpose: RESET_PASSWORD`. The difference: a successful
`verify-otp` call doesn't log the user in — it issues a short-lived (15 min),
single-use reset token (returned in the response body), whose **hash** is stored on
the user row. `POST /auth/reset-password` looks the user up by that hash, so the raw
token is never persisted anywhere. Resetting the password also kills any existing
session — a leaked old session token stops working the moment the password changes.

## OTP brute-force protection

Each `verify-otp` call increments a Redis counter keyed by email (atomic `INCR` +
one-time `EXPIRE`, 15-minute window). More than 5 wrong attempts and it's locked out
with "Too many attempts" until a fresh code is requested — which also resets the
counter. This needed a raw Redis client (`@redis/client`) rather than the
cache-manager abstraction already in the project, since cache-manager's
get/set interface can't do an atomic increment.

## What's genuinely tested vs. what's not

Unit tests cover `AuthService` and `UserService` — happy paths plus the failure
modes that actually matter (wrong password, unverified sign-in, wrong/expired OTP,
the attempt lockout, no-enumeration on forgot-password, bad reset token). No Jest
e2e/supertest suite was written for this phase — instead, every endpoint was
exercised live against the real dev Postgres/Redis containers plus a throwaway local
SMTP catcher (Mailpit), end to end, including pulling the actual emailed OTP codes
out and using them. That live run is what's reflected in the Postman collection's
saved example responses.

## A real bug this caught

`PATCH /user/profile` with a partial body (e.g. just `{"postcode": "..."}`) was
silently wiping `fullName`, `address`, and `householdNotes` to `null`. Cause: with
this project's `tsconfig.json` target (`ES2023`), TypeScript's native class-field
semantics mean every declared-but-unset optional field on `UpdateProfileDto` still
exists as an own `undefined` property on the instance — `Object.assign(user, dto)`
was copying those `undefined`s straight onto the entity. Fixed in
`UserService.updateProfile` by filtering out `undefined` values before assigning;
regression test uses a real `UpdateProfileDto` instance (not a plain object literal)
so it actually reproduces the shape that triggered it. A plain-object-literal test
would have passed right through the bug.

## Two Phase-0 dependency choices reversed

Phase 0 deliberately rode `latest` on `typeorm` (1.1.1) and the matching
`@nestjs/typeorm` 12.x. Writing Phase 1's unit tests surfaced that the entire
`@nestjs/*` family had simultaneously jumped to ESM-only (`"type": "module"`) at
their newest majors — unresolvable by this CommonJS/Jest setup — and
`@nestjs/typeorm`'s new TypeORM-v1 compat shim additionally uses `import.meta.url`,
which no Jest config can downlevel to CommonJS at all (Node's own `require(esm)`
handles it fine at app runtime, which is why `npm run build`/boot worked but `npm
test` didn't). Fix: pinned `typeorm` back to 0.3.x and every `@nestjs/*` package
touched to its 11.x line — the combination the ecosystem has actually run in
production for years. Full detail in `CLAUDE.md`'s decisions log.

## Running it yourself

```bash
docker compose up -d        # Postgres (5433) + Redis (6379), see README.md
npm run migration:run
npm run start:dev
```

`MAIL_HOST`/`MAIL_PORT` in `.env` are still placeholders — point them at a real SMTP
service, or at a local catcher (e.g. `docker run -d -p 1025:1025 -p 8025:8025
axllent/mailpit`, then `MAIL_HOST=localhost MAIL_PORT=1025`, codes show up at
`localhost:8025`) to see OTP emails without sending anything real.

`CLOUDINARY_*` keys are still blank — `POST /user/profile/photo` will 500 until
real keys are supplied; everything else (the multer upload, the controller/service
wiring) is in place and verified up to that point.
