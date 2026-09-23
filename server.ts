import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import routes from './server/routes.js';
import { initDatabase } from './server/db.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function startServer() {
  const app = express();

  // Basic security and parsing middlewares with raw body capture for webhook HMAC
  app.use(cors({ origin: true, credentials: true }));
  app.use(
    express.json({
      limit: '10mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));

  // Initialize relational storage / MySQL
  await initDatabase();

  // Mount API routes
  app.use('/api', routes);
  app.use('/', routes);

  // Serve Vite middleware in development or compiled static files in production
  const isProd = process.env.NODE_ENV === 'production' || __filename.includes('dist');
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(` MSAP 53rd Freshers' Meet 2026 Ticketing Server`);
    console.log(` Running on: http://0.0.0.0:${PORT}`);
    console.log(` User Portal: http://localhost:${PORT}/`);
    console.log(` Hidden Admin Portal: http://localhost:${PORT}/#admin or /admin`);
    console.log(`====================================================`);
  });
}

startServer().catch((err) => {
  console.error('Fatal error launching server:', err);
});
