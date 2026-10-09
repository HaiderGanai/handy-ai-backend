# Handy AI — Backend API Implementation Plan

> Scope of this plan: **NestJS REST API only.** No React Native app, no React admin
> frontend, no OpenAI/GPT-4 layer, no phone OTP, no SendGrid. Those are called out
> explicitly wherever the spec (`Handy AI - Project Specs.md`) assumes them, with the
> stand-in we're using instead. Coding conventions below assume `GUIDE.md` — this plan
> doesn't repeat them.

**Goal:** Working, testable REST API for the Handy AI marketplace: auth, user/provider
profiles, provider vetting, bookings, Stripe Connect payments, messaging, and admin
operations — everything the mobile app and admin dashboard will eventually call.

**Stack:** NestJS, TypeScript, PostgreSQL + TypeORM, Redis (cache-manager), Passport JWT,
nodemailer, bcryptjs, multer (memory storage) + Cloudinary, Stripe (Connect + Checkout),
class-validator.

**Naming convention:** any endpoint acting on the authenticated caller's own data (own
profile, own documents, own device tokens, etc.) never uses `/me` — the JWT guard
already scopes it to `req.user.id`, so "me" is redundant. It's just the resource name
under the singular module prefix: `/user/profile`, `/provider/profile`, not
`/users/me` or `/providers/me`.

**Deferred (explicit, do not build yet):**
| Spec feature | Stand-in for now | Revisit when |
|---|---|---|
| GPT-4 conversational booking (§3) | Deterministic rule-based booking-plan endpoint (flat-rate lookup, simple provider matching) | User says to start the AI phase |
| Phone OTP sign-up | Email OTP only | User asks for phone auth |
| SendGrid transactional email | nodemailer (SMTP) | User provides SendGrid creds / asks to swap |
| React Native app / React admin web | N/A — API only | Separate engagement |
| Push notifications (FCM) | Built last (Phase 7), behind a thin `NotificationsService` interface so the HTTP/DB side doesn't change when FCM is wired in | Phase 7 |

**Image/document uploads:** Cloudinary (not local disk, not S3) for avatars and provider
documents. API keys to be provided later, on demand — build the `CloudinaryModule`/
`CloudinaryService` against `CLOUDINARY_CLOUD_NAME`/`CLOUDINARY_API_KEY`/
`CLOUDINARY_API_SECRET` env vars now; nothing to swap later, just fill in real keys.

Each phase below is a module slice that produces working, independently testable
endpoints. Before starting a phase, we'll run `superpowers:writing-plans` again scoped to
just that phase to get bite-sized TDD tasks — writing that detail for all 8 phases now
would be ~5000 lines of code nobody will read before Phase 3 ships and requirements
shift.

---

## ~~Phase 0 — Project Bootstrap~~ ✅ DONE

- `nest new` (npm), strict TypeScript.
- `@nestjs/config` — `ConfigModule.forRoot({ isGlobal: true })`, `.env.example` committed, real `.env` gitignored.
- `@nestjs/typeorm` + `pg`, `DataSource` config for migrations (no `synchronize: true` past local dev — migrations only).
- `main.ts`: global prefix `api/v1`, global `ValidationPipe({ whitelist: true, transform: true })`, global `ClassSerializerInterceptor`, `app.enableCors()`, `process.on('unhandledRejection'/'uncaughtException')` safety net.
- Redis via `cache-manager` + `cache-manager-ioredis` (or `@nestjs/cache-manager`), module-level `CacheModule.registerAsync`.
- `nodemailer` wrapped in a `MailModule`/`MailService` (SMTP transport from config) — one `sendMail(to, subject, html)` method; templates as simple inline HTML strings for now (no templating engine — YAGNI until there are more than 2-3 emails).
- `CloudinaryModule`/`CloudinaryService` (wraps the `cloudinary` SDK, one `uploadBuffer(buffer, folder)` method returning `secure_url`) — keys arrive later, env vars stubbed in `.env.example` now so the module doesn't block on them.
- ESLint + Prettier (Nest defaults).
- `GET /health` — trivial liveness check (no DB ping needed yet; add when something depends on it).
- `.env.example` keys: `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (last two added when Phase 5 starts).

**Done when:** app boots, connects to Postgres + Redis, `/api/v1/health` returns 200.
✅ Verified live, 2026-10-06.

---

## ~~Phase 1 — Auth & User Core~~ ✅ DONE

Covers spec §4.1 (Sign Up, User Profile, Household Notes) minus phone OTP.

**Entities**
- `User` (`user.entity.ts`): `id`, `email` (unique, normalized lowercase), `password` (hashed, `@Exclude()`), `role` enum (`CUSTOMER | PROVIDER | ADMIN`), `isEmailVerified`, `otpCode` (`@Exclude()`), `otpExpiresAt`, `otpPurpose` enum (`SIGNUP | RESET_PASSWORD`), `fullName`, `address`, `postcode`, `photoUrl`, `householdNotes` (text — access instructions/entry codes/key arrangements; one household per user per spec §9), `createdAt`/`updatedAt`.
- `UserSession` (`user-session.entity.ts`): `id`, `userId`, `refreshTokenHash`, `userAgent`, `createdAt`, `expiresAt` — mirrors the Redis session cache per `GUIDE.md` §5 (logout clears both).

**Endpoints** (`AuthController` at `auth`, `UserController` at `user`)
- `POST /auth/sign-up` — email+password+fullName → creates unverified `User`, issues OTP, emails it via `MailService`, returns `{ message }`.
- `POST /auth/verify-otp` — email+code+purpose → verifies, clears OTP fields, marks verified (for SIGNUP) or allows password reset (for RESET_PASSWORD) by issuing a short-lived reset token.
- `POST /auth/resend-otp` — same response whether or not the email exists/is already verified (no enumeration, per `GUIDE.md` §5).
- `POST /auth/sign-in` — email+password, must be verified → `AuthResponse` (JWT + user).
- `POST /auth/forgot-password` — email → issues OTP (purpose `RESET_PASSWORD`), same non-enumerating response.
- `POST /auth/reset-password` — reset token + new password → updates password, clears token.
- `POST /auth/logout` — guarded, deletes `UserSession` row + Redis key.
- `GET /user/profile` — guarded profile fetch.
- `PATCH /user/profile` — update `fullName`, `address`, `postcode`, `householdNotes`.
- `POST /user/profile/photo` — multer memory upload → `CloudinaryService.uploadBuffer`, sets `photoUrl` to the returned `secure_url`.

**Rules carried from `GUIDE.md`:** OTP via `crypto.randomInt(10000, 100000)`, Redis attempt-counter capping verify attempts, OTP helper (generate+send) as one private method shared across sign-up/forgot-password/resend, roles guard scaffolded now (`RolesGuard` + `@Roles()`) even though only `CUSTOMER` exists until Phase 3 — needed so Phase 3/8 don't retrofit auth.

**Done when:** full sign-up → verify → sign-in → authenticated profile read/update cycle works against Postgres+Redis, logout invalidates the session.
✅ Verified live end-to-end, 2026-10-06 — see `PHASE_1_NOTES.md` for the walkthrough,
`postman/Handy-AI.postman_collection.json` for runnable examples. One deviation from
the plan as written: `UserSession.refreshTokenHash` holds a hash of the JWT's `sid`
(session id) claim, not a separate refresh token — no refresh-token issuance/rotation
endpoint was built (never in this plan's scope). `User` also gained `resetToken`/
`resetTokenExpiresAt` fields beyond the plan's original entity list, needed to
implement the "short-lived reset token" the plan's own `verify-otp` bullet called for.

---

## Phase 2 — Service Catalog

Covers spec §2 (the 4 launch services) — needed as a lookup table before bookings exist.

**Entities**
- `ServiceCategory`: `id`, `name` (`Cleaning | Handyman | Electrical | Plumbing`), `slug`.
- `SubService`: `id`, `categoryId`, `name` (e.g. "Deep clean", "Furniture assembly"), `basePrice`, `baseDurationMinutes` — the flat-rate stand-in for GPT-4 plan generation (see Phase 4 note).

**Migration seeds** the 4 categories + sub-services listed in spec §2 table.

**Endpoints**
- `GET /service-categories` — public, with nested sub-services. (Needed by admin and by the Phase 4 booking-plan endpoint; the mobile app won't call this directly once AI booking lands, but it unblocks everything downstream.)

**Done when:** seeded categories/sub-services are readable via the API.

✅ Done 2026-10-08 — see `PHASE_2_MODULE_GUIDE.md` / `PHASE_2_API.md`. Deviations: price stored as `basePriceCents` (int cents); added `slug`/`sortOrder`; seed prices are placeholders.

---

## Phase 3 — Providers & Vetting

Covers spec §5, §5.1.

**Entities**
- `Provider`: `id`, `userId` (FK → `User`, 1:1, role `PROVIDER`), `bio`, `postcodeCoverage` (array or comma-separated — simple is fine, no geo radius math yet), `status` enum (`PENDING | APPROVED | REJECTED | DISABLED`), `stripeAccountId` (nullable until Phase 5).
- `ProviderServiceCategory`: join table `Provider`↔`ServiceCategory` (which services a provider offers).
- `ProviderAvailability`: `providerId`, `dayOfWeek`, `startTime`, `endTime` — simple weekly recurring window, no calendar exceptions yet (YAGNI until a provider asks for one-off blocking).
- `ProviderDocument`: `providerId`, `type` enum (`GOVERNMENT_ID | RIGHT_TO_WORK | LIABILITY_INSURANCE | REFERENCE | PROFILE_PHOTO`), `fileUrl`, `status` enum (`PENDING | APPROVED | REJECTED`).

**Endpoints**
- `POST /provider/onboarding` — guarded (role `PROVIDER`), creates `Provider` row with bio/coverage/categories/availability.
- `POST /provider/documents` — multer memory upload per document type → `CloudinaryService.uploadBuffer`, stores the returned `secure_url` as `fileUrl`.
- `GET /provider/profile`, `PATCH /provider/profile` — profile management (bio, skills/categories, availability, coverage).
- Admin (role `ADMIN`, under `admin/providers`):
  - `GET /admin/providers?status=PENDING` — applications queue with documents.
  - `POST /admin/providers/:id/approve`, `POST /admin/providers/:id/reject` — manual vetting per §5.1 (all 5 criteria checked by a human, not automated — matches spec's explicit out-of-scope "Automated provider vetting").
  - `POST /admin/providers/:id/disable`, `DELETE /admin/providers/:id`.

**Done when:** a provider can onboard + upload docs, and an admin can list/approve/reject/disable them.

---

## Phase 4 — Bookings

Covers spec §4.2 (booking-related), §3 partially.

**Entities**
- `Booking`: `id`, `userId`, `providerId` (nullable until matched/accepted), `subServiceId`, `scheduledAt`, `durationMinutes`, `price`, `status` enum (`PLAN_PROPOSED | PENDING_PROVIDER | CONFIRMED | DECLINED | IN_PROGRESS | COMPLETED | CANCELLED`), `notes`.
- `TrustedProvider`: join `userId`↔`providerId`, `createdAt`.

**Booking-plan generation — explicit AI stand-in:**
```ts
// ponytail: deterministic stand-in for the GPT-4 plan-generation layer (spec §3).
// Replace this method's body with the AI service call when that phase starts;
// the controller/DTO contract (service+date/time in, plan out) stays the same.
```
`POST /bookings/plan` takes `subServiceId`, `scheduledAt`, optional `notes`; looks up
`basePrice`/`baseDurationMinutes`, finds eligible providers (category + postcode coverage
+ availability window), prioritizes the user's trusted provider if eligible (spec's
"Trusted Provider Priority"), and returns a proposed plan (provider, time, duration,
cost) without persisting anything — mirrors "Handy presents a full plan ... before any
booking action is taken."

**Endpoints**
- `POST /bookings/plan` — see above.
- `POST /bookings` — confirms a proposed plan → creates `Booking` (`PENDING_PROVIDER`), emails/notifies the matched provider (notification hook, real send wired in Phase 7).
- `POST /bookings/:id/accept`, `POST /bookings/:id/decline` — provider-guarded.
- `PATCH /bookings/:id` — edit upcoming booking (owner only, only while not yet `IN_PROGRESS`).
- `DELETE /bookings/:id` — cancel (owner only, upcoming only).
- `POST /bookings/:id/complete` — provider marks complete → triggers Phase 5's payment release.
- `GET /bookings` — booking history for the current user (customer) or job inbox (provider), filtered by role.
- `GET /bookings/:id` — detail, includes `householdNotes` snapshot from the user (surfaced to the assigned provider per spec §3/§5).
- `POST /user/trusted-providers/:providerId` — mark trusted after a completed job (spec's "single tap").
- Admin: `GET /admin/bookings`, `POST /admin/bookings/:id/reassign` (manual intervention per §7).

**Done when:** a customer can request a plan, confirm it, the provider can accept/decline/complete it, and trusted-provider marking + priority matching both work end to end.

---

## Phase 5 — Payments (Stripe Connect)

Covers spec §6.

**Entities**
- `Transaction`: `id`, `bookingId`, `stripePaymentIntentId`, `amount`, `commissionAmount` (20%), `providerPayoutAmount`, `status` enum (`HELD | RELEASED | REFUNDED`).

**Stripe flow** (destination charges, manual capture — matches "charged at booking
confirmation, held until job complete, 20% commission via Connect"):
- Provider onboarding (Phase 3) gains a step: `POST /provider/profile/stripe-account` creates a Stripe Express account + returns an onboarding link.
- Customer `POST /user/payment-method` creates a Stripe Customer + SetupIntent for saving a card during onboarding (spec §4.1).
- `POST /bookings/:id/checkout` — on plan confirmation, creates a Checkout Session (or PaymentIntent directly if no saved card UI needed server-side) with `capture_method: 'manual'`, `transfer_data.destination = provider.stripeAccountId`, `application_fee_amount` = 20% of amount.
- `POST /webhooks/stripe` — handles `checkout.session.completed` → marks `Transaction` `HELD`, `Booking` `CONFIRMED`.
- `bookings/:id/complete` (Phase 4) now also captures the PaymentIntent → Stripe auto-transfers the split → `Transaction` → `RELEASED`.
- `GET /user/receipts`, `GET /provider/earnings` (completed jobs, pending payouts, total earned — spec §5 Earnings Dashboard).
- Admin: `GET /admin/transactions` (status, amount, commission, payout per spec §7).

Refunds stay manual via the Stripe dashboard per spec — no refund endpoint (matches explicit out-of-scope).

**Done when:** a booking can be paid, held, and released with the correct 80/20 split, visible to user/provider/admin.

---

## Phase 6 — In-App Messaging

Covers spec §4.2/§5 "In-App Messaging".

**Entities**
- `Message`: `id`, `bookingId`, `senderId`, `body`, `createdAt`.

**Endpoints**
- `POST /bookings/:id/messages`, `GET /bookings/:id/messages` — guarded so only the booking's customer or assigned provider can read/write. No external contact details ever exposed (enforced by never returning phone/email of the other party in this response).

REST + client polling is enough for v1 — no WebSocket gateway until the user asks for real-time delivery (YAGNI; add a `Gateway` later without changing the REST contract).

**Done when:** the two parties on a booking can exchange messages and no one else can.

---

## Phase 7 — Notifications & Contact Support

Covers spec §4.2 "Push Notifications" and "Contact Support".

- `DeviceToken` entity (`userId`, `token`, `platform`) + `POST /user/device-tokens` to register.
- `NotificationsService` interface with one method (`notify(userId, event, payload)`); Phase 0–6 hooks (booking confirmed/on-the-way/complete/reminder) call this now with a no-op/log implementation. Swap the implementation to Firebase Admin SDK when FCM credentials exist — no caller changes.
- `POST /support/contact` — public or guarded DTO (name/email/message) → `MailService.sendMail` straight to the team inbox. No persistence, no ticket system (matches spec's explicit scope).

**Done when:** notification hooks fire (logged) at the right booking transitions, and contact-support emails land.

---

## Phase 8 — Admin Platform Stats

Covers the remaining piece of spec §7 not already built in Phases 3/4/5.

- `GET /admin/stats` — total users, total providers, active bookings, today's revenue (aggregate query over `Transaction`).
- `GET /admin/users`, `GET /admin/users/:id` — list + booking history.

**Done when:** the admin dashboard has every read it needs to render §7's feature table.

---

## Cross-cutting, applies to every phase

- Every DTO uses `class-validator`, every route follows `GUIDE.md` naming/controller-thinness rules.
- Every phase ships with tests (unit for services, e2e for the controller's happy path + the 1-2 failure modes that would actually bite a user — not exhaustive coverage of every validator).
- Migrations only, never `synchronize: true` outside local dev.
- Each phase ends with its own commit(s); no phase starts until the previous one's endpoints are manually exercised (curl/Postman) and pass.

## Open questions to confirm before Phase 5 specifically
- Stripe test account / Connect platform settings (test mode keys are enough to build against; live keys only needed at launch).
- Target US state for postcode/coverage validation rules (spec says "Start with a specific State" — doesn't block Phases 0-4, needed before launch-ready postcode logic).
