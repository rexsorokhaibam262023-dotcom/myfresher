<<<<<<< HEAD
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
=======
<<<<<<< HEAD
# MSAP Freshers Meet 2026

## Fixed registration/payment backend

This build restores the missing database service, preserves Vercel API subpaths, and improves registration error reporting.

### Required Vercel environment variables

- `DATABASE_URL` — hosted PostgreSQL connection string (Neon/Vercel Postgres/Supabase etc.)
- `REQUIRE_DATABASE=true`
- `JWT_SECRET` — random value of at least 32 characters
- `ADMIN_DEFAULT_EMAIL` and `ADMIN_DEFAULT_PASSWORD`
- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `PAYMENT_UPI_ID`

### Verify after deployment

1. Open `/api/health` and confirm a JSON response with `status: "ok"`.
2. Open `/api/event-settings` and confirm JSON event settings.
3. Submit a test registration. The registration endpoint should return HTTP 201 with an attendee and session token.
4. Then test Razorpay order creation and checkout.

Local development can use `database/local_store.json` when `DATABASE_URL` is not configured and `NODE_ENV` is not `production`.
=======
# party
# party
# party_
# myfresher
>>>>>>> a06c5a4d5a47dacfd80b29f49a2a494b30b8c7ad
>>>>>>> 50874f3631ae1e125bfd0b02e131cff1510d882a
