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
- PostgreSQL + TypeORM, migrations only (no `synchronize: true` past local dev).
- Redis via `cache-manager` — sessions, OTP attempt counters.
- Passport JWT auth; `UserSession` entity mirrors Redis session cache (logout clears both — `GUIDE.md` §5).
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
| 1 | Auth & user core (email OTP sign-up, sign-in, forgot/reset password, profile, household notes) | Not started |
| 2 | Service catalog (4 categories + sub-services, seeded) | Not started |
| 3 | Providers & vetting (onboarding, documents, admin approve/reject) | Not started |
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
  - TypeORM's `latest` tag is now **1.x** (0.3 was retagged `legacy` as of this date)
    — installed 1.x deliberately, not a mistake if you see it in `package.json`.
  - Redis cache: `cache-manager` v7 is Keyv-based now; used `@keyv/redis` (wraps
    `@redis/client`), not `cache-manager-ioredis-yet` (deprecated, built for the old
    store interface) and not a bare `ioredis` client. If Phase 1's OTP attempt
    counter needs atomic `INCR`+`TTL` beyond what the cache-manager interface gives,
    reach for `@redis/client` directly — same Redis client library already in the
    tree, no second one.
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

## Conventions

All naming, controller/service structure, error handling, auth/security rules:
`GUIDE.md`. That file wins on any conflict with existing code. This file is scope/status
context only.

## Env vars (grows per phase — see `PLAN.md` Phase 0 and Phase 5)

`NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
`MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM`,
`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (keys provided
later, on demand), `STRIPE_SECRET_KEY` (Phase 5), `STRIPE_WEBHOOK_SECRET` (Phase 5).
