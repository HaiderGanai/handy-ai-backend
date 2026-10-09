# Handy AI — Backend

NestJS REST API for the Handy AI home services marketplace. See `PLAN.md` for the
phased build plan and `CLAUDE.md` for current scope/status/decisions. Coding
conventions: `GUIDE.md`.

## Requirements

- Node.js, Docker (for local Postgres/Redis — see below)
- Copy `.env.example` to `.env` and fill in values (Cloudinary/Stripe keys can stay
  blank until those phases start)

## Local Postgres/Redis

```bash
docker compose up -d
```

Starts Postgres on `localhost:5433` (not 5432 — that port's already taken by a
system-wide Postgres on this machine, kept untouched) and Redis on `localhost:6379`,
using the `POSTGRES_*`/`REDIS_PORT` values from `.env`.

**Connecting with pgAdmin:** "Host name/address" must be `localhost` — put the
friendly label (e.g. `HandyAi`) in the **Name** field on the General tab instead,
not Host. Host/Port/Maintenance DB/Username/Password go on the Connection tab:
Host `localhost`, Port `5433`, Maintenance DB `postgres`, Username/Password from
your `.env`.

## Scripts

```bash
npm install
npm run start:dev       # dev server with watch
npm run build
npm test                # unit tests
npm run test:e2e        # e2e tests
npm run lint

npm run migration:generate -- src/database/migrations/<Name>
npm run migration:run
npm run migration:revert
```
