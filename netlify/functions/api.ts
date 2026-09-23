import 'dotenv/config';
import routes from '../../server/routes.js';
import { initDatabase } from '../../server/db.js';

// Memoise initDatabase into a single cached promise per function instance
let initDbPromise: Promise<void> | null = null;
function ensureDatabase(): Promise<void> {
  if (!initDbPromise) {
    initDbPromise = initDatabase().catch((err) => {
      initDbPromise = null; // Reset on failure so subsequent requests can retry
      throw err;
    });
  }
  return initDbPromise;
}

export default async function handler(req: Request, _context?: any): Promise<Response> {
  // Ensure database initialization has succeeded
  try {
    await ensureDatabase();
  } catch (dbErr: any) {
    console.error('[API] Database initialization failed:', dbErr);
    return new Response(
      JSON.stringify({ error: 'Database initialization failed: ' + (dbErr?.message || String(dbErr)) }),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } }
    );
  }

  const url = new URL(req.url);

  // Normalize path for the Express router:
  // Netlify redirects /api/* to /.netlify/functions/api/:splat
  // Routes in server/routes.ts are registered as /health, /event-settings, /registrations, /tickets/:token, etc.
  let pathname = url.pathname;
  if (pathname.startsWith('/.netlify/functions/api')) {
    pathname = pathname.slice('/.netlify/functions/api'.length) || '/';
  }
  if (pathname.startsWith('/api/')) {
    pathname = pathname.slice(4);
  } else if (pathname === '/api') {
    pathname = '/';
  }
  if (!pathname.startsWith('/')) {
    pathname = '/' + pathname;
  }

  // Handle CORS preflight directly
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-webhook-token, x-razorpay-signature, x-attendee-token',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Read raw body bytes so HMAC verification (Razorpay & Google Forms) survives unmodified
  const arrayBuffer = await req.arrayBuffer();
  const rawBodyBuffer = Buffer.from(arrayBuffer);
  const rawBodyString = rawBodyBuffer.toString('utf-8');

  // Parse structured body for Express handlers
  let body: any = {};
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (rawBodyBuffer.length > 0) {
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(rawBodyString);
      } catch {
        body = {};
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(rawBodyString));
    } else {
      body = rawBodyBuffer;
    }
  }

  // Convert Web Headers to standard lowercased object
  const headers: Record<string, string> = {};
  req.headers.forEach((val, key) => {
    headers[key.toLowerCase()] = val;
  });

  const clientIp =
    headers['x-forwarded-for']?.split(',')[0].trim() ||
    headers['client-ip'] ||
    '127.0.0.1';

  // Parse query params
  const query: Record<string, string> = {};
  url.searchParams.forEach((val, key) => {
    query[key] = val;
  });

  return new Promise<Response>((resolve) => {
    let responseStatus = 200;
    const responseHeaders = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-webhook-token, x-razorpay-signature, x-attendee-token',
    });
    let settled = false;

    const safeResolve = (resp: Response) => {
      if (!settled) {
        settled = true;
        resolve(resp);
      }
    };

    const expressReq: any = {
      method: req.method,
      url: pathname + url.search,
      originalUrl: url.pathname + url.search,
      path: pathname,
      headers,
      query,
      body,
      rawBody: rawBodyBuffer,
      ip: clientIp,
      connection: { remoteAddress: clientIp },
      socket: { remoteAddress: clientIp },
      get(name: string) {
        return headers[name.toLowerCase()];
      },
      header(name: string) {
        return headers[name.toLowerCase()];
      },
    };

    const expressRes: any = {
      statusCode: 200,
      status(code: number) {
        responseStatus = code;
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string | number) {
        responseHeaders.set(name, String(value));
        return this;
      },
      header(name: string, value: string | number) {
        return this.setHeader(name, value);
      },
      getHeader(name: string) {
        return responseHeaders.get(name);
      },
      json(data: any) {
        if (!responseHeaders.has('content-type')) {
          responseHeaders.set('content-type', 'application/json; charset=utf-8');
        }
        safeResolve(new Response(JSON.stringify(data), { status: responseStatus, headers: responseHeaders }));
        return this;
      },
      send(data: any) {
        if (typeof data === 'object' && !Buffer.isBuffer(data)) {
          return this.json(data);
        }
        if (!responseHeaders.has('content-type')) {
          responseHeaders.set('content-type', 'text/plain; charset=utf-8');
        }
        safeResolve(new Response(data, { status: responseStatus, headers: responseHeaders }));
        return this;
      },
      end(chunk?: any) {
        if (chunk) {
          return this.send(chunk);
        }
        safeResolve(new Response(null, { status: responseStatus, headers: responseHeaders }));
        return this;
      },
    };

    routes(expressReq, expressRes, (err?: any) => {
      if (err) {
        console.error('[API ERROR]', err);
        safeResolve(
          new Response(JSON.stringify({ error: err?.message || 'Internal Server Error' }), {
            status: 500,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          })
        );
      } else {
        safeResolve(
          new Response(JSON.stringify({ error: `Not Found: ${req.method} ${pathname}` }), {
            status: 404,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          })
        );
      }
    });
  });
}

export const config = {
  path: ['/api/*', '/api'],
};
