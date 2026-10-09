# CLAUDE.md — Project Context (Handy AI Backend)

Living context file. Update this whenever a scope decision, phase status, or
architectural call changes — this is what future sessions read to pick up where we
left off. Coding style/conventions live in `GUIDE.md`, not here — don't duplicate them.

## What this project is

Handy AI: AI-powered home services marketplace (cleaning, handyman, electrical,
plumbing), US launch, booking entirely through a conversational AI interface. Full
spec: `Handy AI - Project Specs.md`. Build plan: `PLAN.md`.

**Current engagement scope: NestJS backend REST API only.** No mobile app (React
Native), no admin web frontend (React), built in this repo. Those consume this API
later, elsewhere.

## Explicit scope cuts (do not build these without being asked again)

| Spec says | We're doing instead | Why |
|---|---|---|
| GPT-4 / OpenAI conversational booking | Deterministic rule-based `/bookings/plan` endpoint (flat-rate lookup + simple provider matching) | User: focus on working APIs first, AI layer comes after |
| Phone number sign-up + OTP | Email OTP only | User: skip phone OTP for now |
| SendGrid transactional email | nodemailer (SMTP) | User: no SendGrid yet |

If a future request asks to "add the AI chat" / "add phone login" / "switch to
SendGrid" — that's this list being lifted, not scope creep to push back on.

## Endpoint naming — no `/me`

Any endpoint on the authenticated caller's own data (profile, documents, device
tokens, payment method, earnings...) is scoped by the JWT guard to `req.user.id`
already — `/me` is redundant. Use the plain resource under the singular module
prefix: `/user/profile`, `/provider/profile`, `/user/trusted-providers/:id`, not
`/users/me` or `/providers/me`. Decided 2026-10-06 after `/users/me` read oddly for
something that's *always* "my own profile" by definition.

## Tech stack (locked in)

- NestJS + TypeScript, global prefix `api/v1`.
- PostgreSQL + TypeORM **0.3.x** (not 1.x — see decisions log), migrations only (no `synchronize: true` past local dev).
- Redis: `cache-manager` v7 + `@keyv/redis` for sessions; raw `@redis/client` (`RedisService`) only for the OTP attempt counter's atomic `INCR`+`TTL` (cache-manager's get/set can't do that atomically).
- Passport JWT auth with a session layer on top (JWT carries a `sid` claim checked against a cached session on every request — a plain JWT can't otherwise be revoked before it expires). `UserSession` entity mirrors the Redis session cache; logout clears both — `GUIDE.md` §5. Single active session per user (a new sign-in retires the previous one); no multi-device support.
- nodemailer (SMTP) wrapped in `MailService`.
- bcryptjs for password hashing.
- multer (memory storage) + Cloudinary for all image/document uploads (avatars, provider documents). API keys arrive later, on demand — module is built now against env vars so nothing changes when the keys land.
- Stripe (Connect Express accounts + Checkout/PaymentIntents, manual capture, destination charges, 20% `application_fee_amount`) — from Phase 5 onward.
- class-validator/class-transformer for all DTOs.

## Phase status

Build plan and per-phase detail: `PLAN.md`. Update the status column as phases land.

| Phase | What | Status |
|---|---|---|
| 0 | Project bootstrap (Nest app, TypeORM, config, global pipes, mail module) | Done |
| 1 | Auth & user core (email OTP sign-up, sign-in, forgot/reset password, profile, household notes) | Done |
| 2 | Service catalog (4 categories + sub-services, seeded) | Done |
| 3 | Providers & vetting (onboarding, documents, admin approve/reject) | Done |
| 4 | Bookings (plan → confirm → accept/decline → complete, trusted providers) | Not started |
| 5 | Payments (Stripe Connect, hold/release, 80/20 split) | Not started |
| 6 | In-app messaging (per booking, user↔provider) | Not started |
| 7 | Notifications (FCM-ready interface, no-op impl for now) & contact support | Not started |
| 8 | Admin platform stats | Not started |

## Key architectural decisions log

- 2026-10-06 — Backend-only engagement for now; AI/OpenAI, phone OTP, SendGrid, and
  mobile/admin frontends explicitly deferred (see table above). Plan written as a
  phased roadmap (`PLAN.md`) rather than one giant bite-sized TDD plan — project is
  too large for that to be useful upfront; each phase gets its own detailed task plan
  immediately before it's executed.
- Booking-plan generation (Phase 4) is a deterministic flat-rate/rule-based stand-in
  for the eventual GPT-4 service — same controller/DTO contract either way, so
  swapping in the AI layer later shouldn't touch callers.
- Payments use Stripe Connect **destination charges with manual capture** (not
  separate charges+transfers) — capture on job completion both releases the hold and
  triggers the provider payout/commission split in one Stripe call.
- Notifications built behind a `NotificationsService` interface from day one (even
  though FCM isn't wired until Phase 7) so booking-status hooks in earlier phases
  don't need to change later.
- Uploads go straight to Cloudinary (not local disk, not S3) — see "Endpoint naming"
  decision note above for the `/me`-drop, and Cloudinary keys arrive later on demand.
- 2026-10-06 — Phase 0 complete. Notable calls made while bootstrapping:
  - Scaffolded on Nest **11** (CommonJS + Jest + ESLint), not the Nest 12 the latest
    CLI defaults to (ESM + vitest + oxlint) — Nest 12 just shipped and the
    TypeORM/Passport/Stripe/cache-manager ecosystem this project leans on is proven
    against the CommonJS/Jest setup, not the new ESM one.
  - TypeORM's `latest` tag was `1.x` at the time (0.3 retagged `legacy`) and that's
    what got installed initially — **reversed in Phase 1**, see below. Leaving this
    line as a record of the call, not current state.
  - Redis cache: `cache-manager` v7 is Keyv-based now; used `@keyv/redis` (wraps
    `@redis/client`), not `cache-manager-ioredis-yet` (deprecated, built for the old
    store interface) and not a bare `ioredis` client.
  - Verified end-to-end against real Postgres+Redis (throwaway Docker containers,
    torn down after): app boots, `GET /api/v1/health` → 200.
- 2026-10-06 — Added `docker-compose.yml` for local Postgres (port **5433**, not
  5432) + Redis (6379). This machine already runs a separate, pre-existing
  system-wide Postgres bound to 5432 with unrelated credentials — rather than
  change that shared instance's password to match what the user wants for this
  project, this project gets its own isolated container with exactly those
  credentials (`postgres` / value in `.env`). `DATABASE_URL` in `.env`/`.env.example`
  points at 5433 accordingly. Verified: real user-chosen password connects via
  `psql` and the app boots against it end-to-end.
- 2026-10-06 — Phase 1 complete (auth + user profile). Full writeup:
  `PHASE_1_NOTES.md`. Postman collection with runnable examples:
  `postman/Handy-AI.postman_collection.json`.
  - **Reversed the Phase 0 TypeORM bet.** Writing Phase 1's Jest unit tests
    surfaced that `typeorm@1.x` + `@nestjs/typeorm@12.x` cannot be unit-tested
    under this CommonJS/Jest setup at all: the whole `@nestjs/*` family jumped to
    ESM-only (`"type": "module"`) at their newest majors simultaneously, and
    `@nestjs/typeorm@12.x`'s TypeORM-v1 compat shim additionally uses
    `import.meta.url`, which no Jest transform can downlevel to CommonJS (Node's
    own `require(esm)` handles it fine at app runtime — that's why `npm run
    build`/boot worked throughout but `npm test` couldn't). Pinned back to
    `typeorm@^0.3.31` + `@nestjs/typeorm@^11.0.3`, and for the same ESM reason
    also pinned `@nestjs/cache-manager@^3.1.3`, `@nestjs/config@^4.0.4`,
    `@nestjs/jwt@^11.0.2`, `@nestjs/passport@^11.0.5` — their 11.x/3.x lines,
    all CommonJS, all what the ecosystem has actually run in production for
    years. **Takeaway for future phases: don't ride `latest` on a package whose
    major version shipped in the last few days — verify it's actually
    unit-testable under this project's toolchain before building on it, not
    after.**
  - `JWT_EXPIRES_IN` is a **plain number of seconds** (e.g. `86400`), not a
    duration string like `1d` — it's reused as-is for the Redis/DB session TTL,
    and parsing duration strings for that would've meant a new dependency for
    no real benefit.
  - Found and fixed a real bug via the live verification pass (not caught by
    unit tests, whose mock inputs didn't replicate the real DTO shape): `PATCH
    /user/profile` with a partial body wiped every omitted field to `null`.
    Cause: this project's `tsconfig.json` `target: "ES2023"` gives class fields
    native-define semantics, so every declared-but-unset optional field on
    `UpdateProfileDto` still exists as an own `undefined` property, and
    `Object.assign(user, dto)` copied those onto the entity. Fixed in
    `UserService.updateProfile` by filtering `undefined` values out first. Worth
    remembering for *any* future DTO-merge-onto-entity code in this codebase,
    not just this one spot.

- 2026-10-08 — Local dev DB moved from the Docker Postgres (5433, `handy_ai`) to the
  system-wide Postgres: `localhost:5432`, database `HandyAi`. Credentials in `.env`.
  Docker is now only needed for Redis (and Mailpit if used). Run migrations on the new DB.
- 2026-10-08 — Phase 2 complete (service catalog). Writeups: `PHASE_2_MODULE_GUIDE.md`,
  `PHASE_2_API.md`; Postman "Catalog" folder added. `GET /service-categories` is public.
  - Prices are `basePriceCents` (int, USD cents), not `basePrice` as `PLAN.md` first
    said - Stripe works in cents. Added `slug` (sub-services) and `sortOrder` (both).
  - **Seed prices/durations are my placeholders** - the spec only names the services.
    Needs the user's review before launch; change via a new migration, never by editing
    the one that ran.
  - Seeds live in the migration's `up()`, so `npm run migration:run` on any fresh DB
    gives the full catalog. (A fresh DB needs migrations run - Phase 1 hit this when
    the DB was swapped.)
  - Gotcha: `migration:generate` output has no seed; a first attempt at injecting
    seed code silently didn't match and the migration ran empty - always verify
    seeded rows after running, not just "executed successfully".
- 2026-10-09 - Phase 3 complete (providers & vetting). API reference: `PHASE_3_API.md`.
  - **Roles:** `POST /auth/sign-up` takes optional `role` (`CUSTOMER` default | `PROVIDER`);
    `ADMIN` is rejected by validation. Admins are promoted in the DB:
    `UPDATE users SET role='ADMIN' WHERE email='...'` then sign in again (role lives in the JWT).
  - Provider categories use a plain `@ManyToMany` join table (`provider_service_categories`),
    not a hand-written join entity. `postcodeCoverage` is a text[]; availability is replaced
    wholesale on `PATCH /provider/profile`.
  - Approve requires all 5 document types uploaded; approve/reject stamps every document
    APPROVED/REJECTED (no per-document review endpoint - add if admins need it). Re-uploading
    a document resets it to PENDING and moves a REJECTED provider back to PENDING.
  - Approve allowed from PENDING or DISABLED (that's the re-enable path); reject only from
    PENDING; disable only from APPROVED.
  - `POST /provider/documents` is multipart with the document type as the file field name
    (1-5 files per request, one per type), not a `type` field + one file.
  - Document uploads (JPEG/PNG/PDF, 5 MB each) go to Cloudinary; verified live except the final
    upload call, which needs real `CLOUDINARY_*` keys (returns 500 without them).

## Conventions

All naming, controller/service structure, error handling, auth/security rules:
`GUIDE.md`. That file wins on any conflict with existing code. This file is scope/status
context only.

## Env vars (grows per phase — see `PLAN.md` Phase 0 and Phase 5)

`NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`
(**seconds, not a duration string** — e.g. `86400`, also used as the session's
Redis/DB TTL), `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM`,
`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (keys provided
later, on demand), `STRIPE_SECRET_KEY` (Phase 5), `STRIPE_WEBHOOK_SECRET` (Phase 5).
