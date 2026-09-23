import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import routes from '../server/routes.js';
import { initDatabase, checkDatabaseHealth } from '../server/db.js';

// Single Express app reused across warm serverless invocations.
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(
  express.json({
    limit: '10mb',
    verify: (req: any, _res, buf) => {
      // Preserve the raw body so webhook HMAC signatures can be verified.
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// Mount the API router at both `/api` and `/`. Vercel routes every `/api/*`
// request here via the rewrite in vercel.json; mounting at both prefixes keeps
// routing correct whether or not the `/api` prefix is preserved on `req.url`.
app.use('/api', routes);
app.use('/', routes);


function restoreRewrittenApiPath(req: Request): void {
  // Vercel rewrites /api/:path* to /api/index. Named source parameters that
  // are not used in the destination are forwarded as query parameters, so
  // /api/registrations arrives here with ?path=registrations. Reconstruct the
  // original API URL before Express routing. Keep __path support for any older
  // deployment that used the previous rewrite format.
  try {
    const parsed = new URL(req.url || '/api/index', 'http://localhost');
    const rewrittenPath =
      parsed.searchParams.get('path') || parsed.searchParams.get('__path');
    if (!rewrittenPath) return;

    parsed.searchParams.delete('path');
    parsed.searchParams.delete('__path');
    const query = parsed.searchParams.toString();
    const cleanPath = rewrittenPath.replace(/^\/+|\/+$/g, '');
    req.url = `/api/${cleanPath}${query ? `?${query}` : ''}`;
  } catch (err) {
    console.warn('[API] Could not restore rewritten API path:', err);
  }
}

// initDatabase() must run once before the first request is handled. It is
// memoized so warm invocations skip re-initialization; a failure clears the
// cache so the next invocation can retry a transient outage.
let dbReady: Promise<void> | null = null;
function ensureDatabase(): Promise<void> {
  if (!dbReady) {
    dbReady = initDatabase().catch((err) => {
      dbReady = null;
      throw err;
    });
  }
  return dbReady;
}

function databaseEnvStatus() {
  const source = process.env.DATABASE_URL
    ? 'DATABASE_URL'
    : process.env.POSTGRES_URL
      ? 'POSTGRES_URL'
      : process.env.NETLIFY_DATABASE_URL
        ? 'NETLIFY_DATABASE_URL'
        : 'none';
  const value = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NETLIFY_DATABASE_URL || '';
  const upper = value.toUpperCase();
  const looksPlaceholder =
    upper.includes('USER:PASSWORD@HOST') ||
    upper.includes('REPLACE_WITH') ||
    upper.includes('YOUR_DATABASE') ||
    upper.includes('YOUR_PASSWORD') ||
    upper.includes('YOUR_HOST') ||
    upper.includes('YOUR_USER');

  return {
    configured: Boolean(value),
    source,
    looksPlaceholder,
  };
}

function classifyDatabaseError(message: string): string {
  const text = message.toLowerCase();
  if (text.includes('not configured')) return 'DATABASE_URL_MISSING';
  if (text.includes('placeholder')) return 'DATABASE_URL_PLACEHOLDER';
  if (text.includes('invalid postgresql url') || text.includes('must use postgres')) return 'DATABASE_URL_INVALID';
  if (text.includes('password authentication failed') || text.includes('authentication failed')) return 'DATABASE_AUTH_FAILED';
  if (text.includes('getaddrinfo') || text.includes('enotfound')) return 'DATABASE_HOST_NOT_FOUND';
  if (text.includes('timeout') || text.includes('etimedout')) return 'DATABASE_CONNECTION_TIMEOUT';
  if (text.includes('ssl') || text.includes('certificate')) return 'DATABASE_SSL_ERROR';
  if (text.includes('migration file not found')) return 'DATABASE_MIGRATION_MISSING';
  if (text.includes('database_migration_lock_busy')) return 'DATABASE_MIGRATION_LOCK_BUSY';
  if (text.includes('canceling statement due to statement timeout')) return 'DATABASE_QUERY_TIMEOUT';
  return 'DATABASE_INITIALIZATION_FAILED';
}

export default async function handler(req: Request, res: Response) {
  restoreRewrittenApiPath(req);
  const requestPath = (req.url || '').split('?')[0];

  // Health must stay lightweight and bounded. Do not run migrations here.
  if (requestPath === '/api/health' || requestPath === '/health') {
    const env = databaseEnvStatus();
    try {
      const health = await checkDatabaseHealth();
      res.status(200).json({
        status: 'ok',
        service: "MSAP 53rd Freshers Meet 2026 API",
        database: {
          ...env,
          provider: health.provider,
          connected: health.connected,
          schemaReady: health.schemaReady,
        },
        paymentProvider: 'razorpay',
        timestamp: new Date().toISOString(),
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyDatabaseError(message);
      console.error('[API] Database health probe failed:', { code, message, env });
      res.status(503).json({
        status: 'error',
        service: "MSAP 53rd Freshers Meet 2026 API",
        database: { ...env, code },
        message:
          code === 'DATABASE_URL_MISSING'
            ? 'DATABASE_URL is not configured in the deployment environment.'
            : code === 'DATABASE_URL_PLACEHOLDER'
              ? 'DATABASE_URL contains placeholder values and must be replaced with the real PostgreSQL connection string.'
              : 'Database connectivity check failed. Check the Vercel Function log for the detailed server-side error.',
        timestamp: new Date().toISOString(),
      });
      return;
    }
  }

  try {
    await ensureDatabase();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = classifyDatabaseError(message);
    const env = databaseEnvStatus();
    console.error('[API] Database initialization failed:', { code, message, env });

    // /api/health intentionally returns safe diagnostics so deployment problems
    // can be identified without exposing credentials or connection strings.
    if (requestPath === '/api/health' || requestPath === '/health') {
      res.status(503).json({
        status: 'error',
        service: "MSAP 53rd Freshers Meet 2026 API",
        database: {
          ...env,
          code,
        },
        message:
          code === 'DATABASE_URL_MISSING'
            ? 'DATABASE_URL is not configured in the deployment environment.'
            : code === 'DATABASE_URL_PLACEHOLDER'
              ? 'DATABASE_URL contains placeholder values and must be replaced with the real PostgreSQL connection string.'
              : 'Database initialization failed. Check the Vercel Function log for the detailed server-side error.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const publicMessage =
      code === 'DATABASE_URL_MISSING'
        ? 'Registration database is not configured. Please contact the administrator.'
        : code === 'DATABASE_URL_PLACEHOLDER'
          ? 'Registration database configuration is incomplete. Please contact the administrator.'
          : 'Registration service is temporarily unavailable.';

    res.status(503).json({ error: publicMessage, code });
    return;
  }
  return (app as unknown as (req: Request, res: Response) => void)(req, res);
}
