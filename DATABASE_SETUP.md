# Production Database Setup — Vercel + Neon Postgres

Vercel no longer provides a new standalone "Vercel Postgres" database. For a new project, connect a Postgres provider from the Vercel Marketplace. This project is prepared for Neon Postgres and remains compatible with any normal hosted PostgreSQL connection string.

## Recommended production setup: Neon from Vercel Marketplace

1. Open the Vercel project.
2. Go to **Storage / Marketplace** and install **Neon Postgres** for this project.
3. Create a database on the Free plan if suitable for the event workload.
4. Connect it to **Production** (and Preview/Development if desired).
5. Confirm Vercel created a `DATABASE_URL` environment variable. Prefer the pooled connection URL when Neon offers both pooled and direct URLs.
6. Set these additional Production variables:

```env
NODE_ENV=production
REQUIRE_DATABASE=true
DB_CONNECTION_LIMIT=3
JWT_SECRET=<long random secret>
ADMIN_DEFAULT_EMAIL=<admin email>
ADMIN_DEFAULT_PASSWORD=<strong password>
RAZORPAY_KEY_ID=<Razorpay key id>
RAZORPAY_KEY_SECRET=<Razorpay secret>
RAZORPAY_WEBHOOK_SECRET=<Razorpay webhook secret>
PAYMENT_UPI_ID=<verified VPA>
```

7. Redeploy after the database is connected. The application automatically installs `database/migrations/001_create_schema.sql` the first time it connects.
8. Open `/api/health`. Expected result includes `status: "ok"` and `database: "PostgreSQL"`.

## Manual schema installation (optional)

If you want to initialize the DB before deployment, copy the provider connection string into a local `.env` as `DATABASE_URL`, then run:

```bash
npm run db:setup
npm run db:check
```

The schema creates these persistent tables:

- `admins`
- `attendees`
- `payment_transactions`
- `checkins`
- `audit_logs`
- `event_settings`
- `ticket_counter`
- `schema_migrations`

The application creates the first administrator using `ADMIN_DEFAULT_EMAIL` and `ADMIN_DEFAULT_PASSWORD` on first startup. Do not put a plaintext administrator password in SQL.

## Local PostgreSQL database included

For local development with Docker Desktop:

```bash
docker compose up -d
copy .env.local.example .env
npm run db:check
npm run dev
```

The included local database is PostgreSQL 17 and persists in the Docker volume `msap_postgres_data`.

## Important

`database/local_store.json` is development-only. Vercel Functions do not provide a persistent writable local filesystem for application database storage, so production registrations and payment records must use a hosted database.
