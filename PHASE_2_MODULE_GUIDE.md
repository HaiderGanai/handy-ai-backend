# Phase 2 — Module Guide: Service Catalog

How the catalog works internally. API reference: `PHASE_2_API.md`. Scope/status:
`CLAUDE.md`, `PLAN.md`.

## 1. What this phase is

A read-only lookup table of what Handy can book: 4 categories (spec §2), each with
4 sub-services, each carrying a flat price and duration. Later phases consume it:
- Phase 3: providers pick which **categories** they offer.
- Phase 4: the deterministic `/bookings/plan` endpoint prices a job from a
  **sub-service**'s `basePriceCents` and `baseDurationMinutes` (the stand-in for the
  eventual GPT-4 planner).

There is no create/update/delete API. The data is seeded by a migration; changing it
means a new migration (or a future admin endpoint, if ever asked for).

## 2. Files

| Path | Role |
|---|---|
| `src/catalog/catalog.module.ts` | Wires entities, controller, service; exports `TypeOrmModule` + `CatalogService` for Phase 3/4 |
| `src/catalog/catalog.controller.ts` | `GET /service-categories`, public (no guard) |
| `src/catalog/catalog.service.ts` | `getServiceCategories()` — one query with the relation joined |
| `src/catalog/entities/service-category.entity.ts` | `service_categories` table |
| `src/catalog/entities/sub-service.entity.ts` | `sub_services` table |
| `src/catalog/enums/service-category-name.enum.ts` | `Cleaning / Handyman / Electrical / Plumbing` |
| `src/catalog/catalog.service.spec.ts` | Unit test |
| `src/database/migrations/…Phase2ServiceCatalog.ts` | Schema **and** seed data |

## 3. Data model

### `service_categories`
| Column | Notes |
|---|---|
| `id` | uuid PK |
| `name` | enum `ServiceCategoryName`, unique |
| `slug` | unique, e.g. `cleaning` — stable identifier for clients |
| `sortOrder` | display order (Cleaning 0, Handyman 1, Electrical 2, Plumbing 3) |

### `sub_services`
| Column | Notes |
|---|---|
| `id` | uuid PK |
| `categoryId` | FK → `service_categories.id`, `ON DELETE CASCADE` |
| `name`, `slug` | e.g. "Deep clean" / `deep-clean` |
| `basePriceCents` | integer USD cents (see decisions) |
| `baseDurationMinutes` | integer |
| `sortOrder` | order within its category |

## 4. Seed data

Inserted by the migration's `up()` from a `CATALOG` constant at the top of the file;
`down()` drops the tables (data goes with them).

| Category | Sub-service | Price | Duration |
|---|---|---|---|
| Cleaning | Regular home clean | $80.00 | 120 min |
| | Deep clean | $150.00 | 240 min |
| | One-off clean | $100.00 | 150 min |
| | End of tenancy clean | $220.00 | 300 min |
| Handyman | Furniture assembly | $70.00 | 90 min |
| | TV and shelf mounting | $80.00 | 60 min |
| | Minor repairs | $90.00 | 90 min |
| | Basic maintenance | $75.00 | 60 min |
| Electrical | Light fixture installation | $95.00 | 60 min |
| | Socket repairs | $85.00 | 60 min |
| | Minor wiring fixes | $120.00 | 90 min |
| | Switch replacements | $75.00 | 45 min |
| Plumbing | Leak repairs | $110.00 | 90 min |
| | Blocked drains | $100.00 | 60 min |
| | Tap replacement | $90.00 | 60 min |
| | Toilet repairs | $105.00 | 90 min |

**The category and sub-service names come from the spec. The prices and durations are
placeholders I chose** — the spec gives none. Review them before launch; to change
them, edit `CATALOG` in a *new* migration (never edit one that already ran elsewhere).

## 5. Request flow — `GET /service-categories`

1. No `AuthGuard` on the controller, so anyone can call it (the catalog is not
   sensitive and clients need it before sign-in).
2. `CatalogController.getServiceCategories()` → `CatalogService.getServiceCategories()`
   (same name, per `GUIDE.md` §2.1).
3. One `find` with `relations: { subServices: true }` and
   `order: { sortOrder: 'ASC', subServices: { sortOrder: 'ASC' } }` — TypeORM issues
   a single joined query; no N+1.
4. The array is returned as-is (no `@Exclude()` fields exist on these entities).
   Sub-services also carry `categoryId` in the response.

## 6. Decisions worth knowing

- **Price is `basePriceCents` (int), not `basePrice` as `PLAN.md` first wrote it.**
  Stripe (Phase 5) works in cents; storing cents avoids float/`numeric`-as-string
  surprises in TypeORM. Currency is USD (US launch).
- **Added `slug` on sub-services and `sortOrder` on both** — not in the plan. Without
  `sortOrder` the API order would be arbitrary; `slug` gives clients a stable key.
- **Seeds in the migration, not a seed script**, so any fresh database gets the catalog
  from `npm run migration:run` with no extra step.
- **Category `name` is a Postgres enum** (per the plan's fixed list). Adding a fifth
  category later means a migration that alters the enum.
- **Only one endpoint**, as planned. No lookup by slug/id yet; Phase 4 will use the
  repository/service directly rather than HTTP.

## 7. Verification done

- Migration run on the `HandyAi` database; lint, build, and all 16 unit tests pass.
- Booted the built app on a spare port and called the endpoint: 4 categories, 16
  sub-services, correct order and values.
