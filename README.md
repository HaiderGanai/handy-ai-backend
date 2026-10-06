# Handy AI — Backend

NestJS REST API for the Handy AI home services marketplace. See `PLAN.md` for the
phased build plan and `CLAUDE.md` for current scope/status/decisions. Coding
conventions: `GUIDE.md`.

## Requirements

- Node.js, PostgreSQL, Redis
- Copy `.env.example` to `.env` and fill in values (Cloudinary/Stripe keys can stay
  blank until those phases start)

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
