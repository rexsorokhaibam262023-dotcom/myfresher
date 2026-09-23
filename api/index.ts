import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import routes from '../server/routes.js';
import { initDatabase } from '../server/db.js';

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
  // vercel.json rewrites /api/:path* -> /api?__path=:path*. Reconstruct the
  // original URL before Express routing so /api/registrations, /api/health, etc.
  // do not collapse to the bare /api function endpoint.
  try {
    const parsed = new URL(req.url || '/api', 'http://localhost');
    const rewrittenPath = parsed.searchParams.get('__path');
    if (!rewrittenPath) return;
    parsed.searchParams.delete('__path');
    const query = parsed.searchParams.toString();
    req.url = `/api/${rewrittenPath}${query ? `?${query}` : ''}`;
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

export default async function handler(req: Request, res: Response) {
  restoreRewrittenApiPath(req);
  try {
    await ensureDatabase();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[API] Database initialization failed:', message);
    res.status(503).json({ error: 'Registration service is temporarily unavailable.' });
    return;
  }
  return (app as unknown as (req: Request, res: Response) => void)(req, res);
}
