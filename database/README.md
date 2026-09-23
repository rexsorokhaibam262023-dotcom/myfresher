# Database Files

- `MSAP_Freshers_PostgreSQL_DB.sql` — complete PostgreSQL schema/base seed for manual import.
- `migrations/001_create_schema.sql` — schema migration used automatically by the API.
- `local_store.json` — development-only fallback; never use this as the Vercel production database.

For production on Vercel, provision Neon Postgres through the Vercel Marketplace and let Vercel inject `DATABASE_URL`. The API applies the migration automatically once.
