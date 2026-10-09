# Phase 3 — Module Guide: Providers & Vetting

How providers and manual vetting work internally. API reference: `PHASE_3_API.md`.
Scope/status: `CLAUDE.md`, `PLAN.md`.

## 1. What this phase is

A user who signs up as a provider describes what they offer (bio, categories, postcodes,
weekly availability), uploads their vetting documents, and then waits. A human admin
reviews and approves or rejects them (spec §5.1: vetting is manual, not automated).

Later phases consume it:
- Phase 4 matches bookings only against `APPROVED` providers, using `categories`,
  `postcodeCoverage` and `availability`.
- Phase 5 fills `stripeAccountId` (Stripe Connect onboarding).

## 2. Files

| Path | Role |
|---|---|
| `src/provider/provider.module.ts` | Wires entities, both controllers, both services, `CloudinaryModule`; exports `TypeOrmModule` + `ProviderService` |
| `src/provider/provider.controller.ts` | `/provider/*` — guarded by JWT + `RolesGuard`, role `PROVIDER` |
| `src/provider/admin-provider.controller.ts` | `/admin/providers/*` — JWT + `RolesGuard`, role `ADMIN` |
| `src/provider/services/provider.service.ts` | onboarding, profile get/update, document upload |
| `src/provider/services/admin-provider.service.ts` | list, approve, reject, disable, delete |
| `src/provider/entities/*.entity.ts` | `Provider`, `ProviderAvailability`, `ProviderDocument` |
| `src/provider/enums/*.enum.ts` | `ProviderStatus`, `DocumentType`, `DocumentStatus` |
| `src/provider/dto/*.dto.ts` | request DTOs (onboarding, profile update, availability slot, reject, list query) |
| `src/provider/services/*.spec.ts` | unit tests for both services |
| `src/database/migrations/…Phase3ProvidersVetting.ts` | the four new tables |
| `src/auth/dto/sign-up.dto.ts`, `auth.service.ts` | sign-up now accepts `role`; `signIn` refuses admins, new `adminSignIn` |
| `src/auth/admin-auth.controller.ts` | `POST /admin/auth/sign-in` |

Controller method names equal service method names (`GUIDE.md` §2.1); the acting user is
always `req.user.id` from the JWT, never from the body.

## 3. Roles

- `Role` already had `CUSTOMER | PROVIDER | ADMIN`, and `RolesGuard` + `@Roles()` were built
  in Phase 1 but unused. Phase 3 is their first use:
  `@UseGuards(AuthGuard('jwt'), RolesGuard)` then `@Roles(Role.PROVIDER)` on the class.
- **How a user becomes a provider:** `SignUpDto.role` (optional, `@IsIn([CUSTOMER,
  PROVIDER])`), stored on the user at sign-up. Fixed afterwards; no role-switch endpoint.
- **How a user becomes an admin:** only by creating/editing the row in the database
  (`role='ADMIN'`). `ADMIN` can never be requested at sign-up.
- **Admin login is separate:** `POST /admin/auth/sign-in` (`AdminAuthController` →
  `AuthService.adminSignIn`) accepts only `ADMIN` users, and `AuthService.signIn` rejects
  `ADMIN` users. Both share a private `verifyCredentials` (verified email + bcrypt check),
  then check the role and return the same generic `Invalid credentials!` 401 for a wrong role,
  so the endpoints don't reveal which emails are admins. Session creation is shared.
  `forgot-password`/`reset-password` remain shared with normal users.
- The role is read from the **JWT** (`JwtStrategy.validate`), so a changed role only takes
  effect after signing in again.

## 4. Data model

### `providers`
| Column | Notes |
|---|---|
| `id` | uuid PK |
| `userId` | uuid, **unique** FK → `users.id`, `ON DELETE CASCADE` (1 provider per user) |
| `bio` | text |
| `postcodeCoverage` | `text[]` — plain list of postcodes/prefixes, no geo-radius maths |
| `status` | enum `PENDING` (default) / `APPROVED` / `REJECTED` / `DISABLED` |
| `rejectionReason` | nullable varchar; set on reject, cleared on approve/resubmit |
| `stripeAccountId` | nullable; unused until Phase 5 |
| `createdAt`, `updatedAt` | |

### `provider_service_categories` (join table)
`providerId` ↔ `categoryId` (FK → `service_categories`). Created by TypeORM from a
`@ManyToMany` + `@JoinTable` on `Provider.categories` — there is no hand-written join
entity (it would carry no extra data).

### `provider_availability`
`id`, `providerId` (FK, cascade delete), `dayOfWeek` smallint 0=Sunday..6=Saturday,
`startTime`/`endTime` Postgres `time`. A simple weekly recurring window; no one-off
blocks or calendar exceptions (add when a provider needs them).

### `provider_documents`
`id`, `providerId` (FK, cascade delete), `type` enum, `fileUrl` (Cloudinary
`secure_url`), `status` enum `PENDING/APPROVED/REJECTED`, `createdAt`.
**Unique on (`providerId`, `type`)**: at most one document per type; re-uploading
replaces it.

## 5. Request flows

### Onboarding — `POST /provider/onboarding`
1. Reject with 409 if a `Provider` already exists for `req.user.id`.
2. Load the categories for `categoryIds` (de-duplicated). If the count doesn't match,
   400 — an unknown id never silently drops.
3. Check each availability slot has `startTime < endTime` (`HH:mm` strings compare
   correctly as text).
4. One `repository.save` of the provider with `categories` and `availability`
   (cascade) — a single transaction.

### Profile update — `PATCH /provider/profile`
Loads the profile and copies over **only fields that are not `undefined`**. This
matters: with this project's ES2023 target, a DTO's omitted optional fields are still own
properties set to `undefined`, and a naive `Object.assign` would wipe them (the same bug
found in Phase 1's profile update). Availability is replaced wholesale: old rows are
deleted (`orphanedRowAction: 'delete'`) and the new ones inserted.

### Document upload — `POST /provider/documents`
1. `FileFieldsInterceptor` is configured with five fields named after `DocumentType`,
   `maxCount: 1` each, and a 5 MB per-file limit. The multipart **field name is the
   document type**, so there is no `type` in the body. An unknown field name makes
   multer throw `Unexpected file field - <name>` (400); at most 5 files can ever arrive.
2. The service rejects an empty upload, then any file whose mimetype isn't JPEG, PNG or
   PDF — **before** anything is uploaded, so a bad file means no partial upload.
3. Uploads all files to Cloudinary in parallel (`handy-ai/provider-documents/<providerId>`),
   then upserts one `ProviderDocument` per file (existing type → `fileUrl` replaced and
   status back to `PENDING`).
4. If the provider was `REJECTED`, it moves back to `PENDING` (and `rejectionReason`
   clears), so resubmitting puts them back in the admin queue without extra endpoints.

### Admin vetting
| Action | Allowed from | Effect |
|---|---|---|
| approve | `PENDING`, `DISABLED` | needs all 5 document types on file; provider + all documents → `APPROVED` |
| reject | `PENDING` | provider + all documents → `REJECTED`, stores optional reason |
| disable | `APPROVED` | provider → `DISABLED` |
| delete | any | removes the provider; documents/availability cascade; user keeps the account |

Invalid transitions return 400 with a plain message. `:id` is validated with
`ParseUUIDPipe`.

## 6. Decisions worth knowing

- **Role at sign-up** instead of a "become a provider" step: the plan said onboarding is
  guarded by role `PROVIDER`, but nothing could ever assign that role. Cheapest fix that
  keeps the plan's guard intact. If customers should be able to upgrade later, that's a
  separate endpoint.
- **Admin created in the database**, not seeded or env-driven (the first admin, `admin@admin.com`, was inserted directly with a bcrypt hash): one-time operation, no new code path that
  could be abused. Revisit if admins need to be created regularly.
- **Document review is all-or-nothing.** Approve/reject sets every document's status
  with the provider's. `ProviderDocument.status` exists per the plan, but there is no
  per-document endpoint ("this ID is blurry, the rest are fine"). Add
  `POST /admin/providers/documents/:id/approve|reject` if admins need that.
- **Upload keyed by document type** (field name), because it lets a provider send all
  five at once and rules out invalid types at the multer level for free.
- **Approve checks documents are *present*, not that Cloudinary files are valid** — the
  admin is expected to open the URLs and judge them (manual vetting).
- **Hard delete** for `DELETE /admin/providers/:id`; no soft-delete column. Use
  `disable` to suspend reversibly.
- **Cloudinary is not mocked in the app** — unit tests mock the service; live runs need
  real `CLOUDINARY_*` keys. Without them the upload call returns 500.

## 7. Verification done

- Migration run on the `HandyAi` database; lint, build and all 26 unit tests pass.
- Live against the real app + Postgres + Redis (spare port): provider sign-up with role
  (and `ADMIN` rejected), onboarding, duplicate onboarding 409, partial profile update
  keeps other fields and replaces availability, role guards (403 wrong role, 401 no
  token), admin list, approve-without-documents 400, reject → approve-from-rejected 400,
  approve, disable, bad-uuid 400, delete cascades to documents and availability.
- Upload validation verified live (unknown field, no files, bad mime, valid files reach
  Cloudinary). **Not verified: a successful Cloudinary upload** — no keys yet.
