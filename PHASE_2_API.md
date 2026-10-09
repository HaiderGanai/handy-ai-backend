# Phase 2 — API Reference (Postman-style)

**Base URL:** `http://localhost:3000/api/v1`

Postman variable `baseUrl` = `http://localhost:3000/api/v1`. The request is also in
`postman/Handy-AI.postman_collection.json` under **Catalog**.

---

## Catalog

### GET `{{baseUrl}}/service-categories`
Public: no auth header, no body, no query params.

Returns all service categories in display order, each with its sub-services in
display order. Prices are **USD cents**.

| Status | Meaning |
|---|---|
| **200** | list of categories (below) |
| 500 | `{ "statusCode": 500, "message": "Internal server error" }` — usually the migration hasn't been run on the database |

**200 OK** (trimmed to the first two sub-services of the first category; the real
response has 4 categories x 4 sub-services = 16)
```json
[
  {
    "id": "<uuid>",
    "name": "Cleaning",
    "slug": "cleaning",
    "sortOrder": 0,
    "subServices": [
      {
        "id": "<uuid>",
        "categoryId": "<uuid>",
        "name": "Regular home clean",
        "slug": "regular-home-clean",
        "basePriceCents": 8000,
        "baseDurationMinutes": 120,
        "sortOrder": 0
      },
      {
        "id": "<uuid>",
        "categoryId": "<uuid>",
        "name": "Deep clean",
        "slug": "deep-clean",
        "basePriceCents": 15000,
        "baseDurationMinutes": 240,
        "sortOrder": 1
      }
    ]
  }
]
```

Expected full contents (order matters)

| `name` (slug) | sub-services in order → `basePriceCents` / `baseDurationMinutes` |
|---|---|
| Cleaning (`cleaning`) | Regular home clean 8000/120 · Deep clean 15000/240 · One-off clean 10000/150 · End of tenancy clean 22000/300 |
| Handyman (`handyman`) | Furniture assembly 7000/90 · TV and shelf mounting 8000/60 · Minor repairs 9000/90 · Basic maintenance 7500/60 |
| Electrical (`electrical`) | Light fixture installation 9500/60 · Socket repairs 8500/60 · Minor wiring fixes 12000/90 · Switch replacements 7500/45 |
| Plumbing (`plumbing`) | Leak repairs 11000/90 · Blocked drains 10000/60 · Tap replacement 9000/60 · Toilet repairs 10500/90 |

**Postman test script** (optional sanity check)
```js
const body = pm.response.json();
pm.test("4 categories", () => pm.expect(body.length).to.eql(4));
pm.test("16 sub-services", () =>
  pm.expect(body.flatMap(c => c.subServices).length).to.eql(16));
```

Setup note: run `npm run migration:run` first; the seed data comes with the migration.
