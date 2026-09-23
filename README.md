# MSAP 53rd Freshers' Meet 2026 Ticketing System

## Local development

```bash
npm install
copy .env.local.example .env
# Optional production-like DB: docker compose up -d
npm run dev
```

## Vercel production

This project requires a persistent PostgreSQL database. The recommended path is **Neon Postgres from Vercel Marketplace**. See `DATABASE_SETUP.md`.

After connecting Neon and setting the production environment variables:

```text
/api/health
/api/event-settings
```

must return JSON successfully before testing registration/payment.

## Database utilities

```bash
npm run db:setup   # install/repair PostgreSQL schema
npm run db:check   # verify connection and application tables
```

The API automatically applies the initial schema once, guarded by a migration record and PostgreSQL advisory lock.
