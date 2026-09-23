# Registration Server Fix Notes

## What was broken

1. `server/db.ts` was truncated at 42 lines, while `server/routes.ts` imports the full database service from it. The missing exports prevented registration, ticket lookup, payment state handling, admin verification, and check-in operations from working.
2. `vercel.json` rewrote every `/api/*` request to the bare `/api` endpoint without preserving the route path. This could make `/api/registrations`, `/api/health`, etc. reach the function without the intended Express route.
3. The registration UI called `res.json()` unconditionally. An HTML 404/500 response therefore became the generic message `Unable to connect to registration server`, hiding the real deployment problem.
4. Admin login contained development password bypasses that were not limited to development mode.

## What was fixed

- Rebuilt `server/db.ts` with a PostgreSQL production implementation and a development-only JSON fallback.
- Added database bootstrap/migration, admin seed, event settings seed, registration creation, duplicate handling, attendee lookup, payment transaction handling, UTR submission, admin payment verification/rejection, ticket generation, QR verification, check-in, refund/revocation, dashboard stats, and attendee listing.
- Preserved Vercel API subpaths using a rewrite marker and restored the original path before Express routing.
- Improved frontend registration response handling so non-JSON server responses show a useful HTTP/API deployment error instead of a misleading network message.
- Added `REQUIRE_DATABASE=true` as the preferred environment flag while retaining the old `REQUIRE_MYSQL` alias for compatibility.
- Added PostgreSQL referential integrity from `payment_transactions.registration_id` to `attendees.id` for new databases.
- Limited development admin password bypasses to non-production environments.

## Validation performed

- Verified that all 23 database functions imported by `server/routes.ts` are now exported by `server/db.ts`.
- TypeScript syntax-transpilation check passed for all `.ts` and `.tsx` files.
- Ran a local database lifecycle smoke test covering:
  - registration creation
  - duplicate detection
  - secure attendee lookup
  - UTR submission
  - admin payment verification
  - ticket/QR generation
  - QR validation
  - check-in
  - dashboard statistics

The full production flow still requires your real hosted PostgreSQL and Razorpay credentials, so Razorpay/network calls were not executed during this offline code repair.

## Required Vercel environment variables

At minimum configure:

- `DATABASE_URL`
- `REQUIRE_DATABASE=true`
- `JWT_SECRET` (32+ characters)
- `ADMIN_DEFAULT_EMAIL`
- `ADMIN_DEFAULT_PASSWORD`
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `PAYMENT_UPI_ID`

## Post-deployment checks

1. `GET /api/health` → should return JSON with `status: "ok"` and `database: "PostgreSQL"`.
2. `GET /api/event-settings` → should return JSON event settings.
3. Submit a fresh registration → `POST /api/registrations` should return HTTP 201 with `attendee` and `sessionToken`.
4. Then test Razorpay order creation and checkout.
