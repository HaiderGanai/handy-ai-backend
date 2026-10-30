# Demo data (dev / frontend testing)

Dummy accounts and bookings so the frontend has every state to render. Created by
`src/database/seeds/demo-data.seed.ts`. **Dev only** - the password is public.

- Password for every account: **`Demo@1234`**
- All emails are verified; all providers are `APPROVED` with all 5 documents `APPROVED`.
- Sign in with `POST /auth/sign-in` (customers and providers alike).
- Only rows with emails ending `@handyai-demo.dev` are ever touched by the seed.

## Accounts

| Role | Name | Email | Postcode | Categories |
|---|---|---|---|---|
| Customer | Olivia Bennett | customer.olivia@handyai-demo.dev | SW1A 1AA | - |
| Customer | Liam Carter | customer.liam@handyai-demo.dev | SW3 4HN | - |
| Customer | Emma Davies | customer.emma@handyai-demo.dev | E1 6AN | - |
| Customer | Noah Evans | customer.noah@handyai-demo.dev | N1 9GU | - |
| Customer | Ava Foster | customer.ava@handyai-demo.dev | W1D 3QU | - |
| Provider | Marcus Reed | provider.marcus@handyai-demo.dev | covers SW1A 1AA, SW3 4HN, E1 6AN | Cleaning |
| Provider | Sofia Alvarez | provider.sofia@handyai-demo.dev | covers N1 9GU, W1D 3QU, E1 6AN, SW1A 1AA | Cleaning |
| Provider | Daniel Brooks | provider.daniel@handyai-demo.dev | all five | Handyman |
| Provider | Priya Shah | provider.priya@handyai-demo.dev | all five | Electrical |
| Provider | Tom Hughes | provider.tom@handyai-demo.dev | all five | Plumbing |
| Provider | Grace Liu | provider.grace@handyai-demo.dev | all five | Handyman + Cleaning |

Providers work Mon-Sat 08:00-20:00 (UTC). Provider coverage lists the customers' exact
postcodes, because plan matching is an exact postcode match.

## Bookings (22)

| Status | Count | Notes |
|---|---|---|
| `COMPLETED` | 8 | history, 2-45 days ago |
| `IN_PROGRESS` | 3 | started 20-90 min before the seed ran (shows in `GET /bookings/in-progress`, not in `GET /bookings`) |
| `CONFIRMED` | 4 | next 1-5 days; the provider can press **start** |
| `PENDING_PROVIDER` | 3 | next 4-7 days; the provider can **accept** / **decline** |
| `DECLINED` | 2 | |
| `CANCELLED` | 2 | |

Trusted-provider links: Olivia -> Marcus, Liam -> Daniel, Noah -> Tom, Ava -> Sofia (planning a
job for those customers prefers that provider).

## Payments (Phase 5)

Every demo booking also has a payment record with **fake Stripe ids** (`pi_demo_N`, `ch_demo_N`,
`tr_demo_N`), so receipts, earnings and the admin transaction list have data:

| Booking status | Payment record |
|---|---|
| `COMPLETED` | `RELEASED` (provider paid) - except Grace's, which are `CAPTURED` (awaiting payout) |
| `PENDING_PROVIDER`, `CONFIRMED`, `IN_PROGRESS` | `HELD` |
| `DECLINED`, `CANCELLED` | `CANCELLED` |

Five providers have a fake connected Stripe account (`acct_demo_<name>`); **Grace** has none, to show
the "connect Stripe" / awaiting-payout state. Real Stripe calls on these bookings (e.g. completing an
`IN_PROGRESS` one) would fail because the ids don't exist at Stripe - use them to browse, not to pay.

## Commands

```bash
npm run seed:demo          # create / reset the demo data (re-runnable, no duplicates)
npm run seed:demo:remove   # delete only the demo data
```
Run against whatever `DATABASE_URL` in `.env` points at (the script prints the target host
first). Dates are relative to when the seed runs, so re-run it to refresh "today" and the
upcoming/in-progress jobs. Actions taken while testing (accept, start, complete...) change the
data; re-running resets it.
