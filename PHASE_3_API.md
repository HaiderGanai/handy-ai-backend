# Phase 3 API - Providers & Vetting

Base URL: `http://localhost:3000/api/v1`. All routes need `Authorization: Bearer <accessToken>`.
Provider routes need role `PROVIDER`; admin routes need role `ADMIN` (else 403).

Getting the roles: sign up with `"role": "PROVIDER"` (optional field on `POST /auth/sign-up`;
`ADMIN` is rejected). Admins are promoted in the DB, then must sign in again:

```sql
UPDATE users SET role = 'ADMIN' WHERE email = 'admin@example.com';
```

## Provider

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/provider/onboarding` | JSON, below | 201 provider (status `PENDING`). 409 if already onboarded. |
| GET | `/provider/profile` | - | provider + categories, availability, documents |
| PATCH | `/provider/profile` | any subset of the onboarding fields | updated provider. `availability` / `categoryIds` replace the old values. |
| POST | `/provider/documents` | multipart form-data, 1 to 5 file fields (see below) | array of the saved documents (status `PENDING`) |

Onboarding body:

```json
{
  "bio": "10 years of plumbing experience",
  "postcodeCoverage": ["SW1", "SW3"],
  "categoryIds": ["<service-category uuid from GET /service-categories>"],
  "availability": [{ "dayOfWeek": 1, "startTime": "09:00", "endTime": "17:00" }]
}
```

`dayOfWeek` is 0 (Sunday) to 6. Times are `HH:mm`, start before end.

### Uploading documents

In Postman choose Body > form-data and add one row per file with the **key set to the document
type** and the value type set to **File**. There is no separate `type` field. Valid keys:
`GOVERNMENT_ID`, `RIGHT_TO_WORK`, `LIABILITY_INSURANCE`, `REFERENCE`, `PROFILE_PHOTO`.

Send 1 to 5 files per request (one per key, so 5 at most). Any other key returns
`Unexpected file field - <key>`. Files must be JPEG, PNG or PDF, max 5 MB each; if any file is
invalid nothing is uploaded. Uploading a type that already exists replaces it and sets it back to
`PENDING`; a `REJECTED` provider who re-uploads returns to `PENDING`.

## Admin

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/admin/providers?status=PENDING` | - | providers with user, categories, availability, documents (`status` optional) |
| POST | `/admin/providers/:id/approve` | - | `APPROVED`. 400 unless the provider is `PENDING`/`DISABLED` and all 5 document types are uploaded. Marks documents `APPROVED`. |
| POST | `/admin/providers/:id/reject` | `{ "reason": "..." }` (optional) | `REJECTED` with `rejectionReason`. 400 unless `PENDING`. Marks documents `REJECTED`. |
| POST | `/admin/providers/:id/disable` | - | `DISABLED`. 400 unless `APPROVED`. |
| DELETE | `/admin/providers/:id` | - | `{ "message": "Provider deleted!" }` (documents/availability cascade) |
