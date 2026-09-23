import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NETLIFY_DATABASE_URL;
if (!url) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(url);
const pool = new pg.Pool({
  connectionString: url,
  max: 1,
  connectionTimeoutMillis: 10000,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  allowExitOnIdle: true,
});

try {
  const version = await pool.query('SELECT version() AS version, current_database() AS database, current_user AS username');
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('admins','attendees','payment_transactions','checkins','audit_logs','event_settings','ticket_counter','schema_migrations')
    ORDER BY table_name
  `);
  console.log('Database connection: OK');
  console.log('Database:', version.rows[0].database);
  console.log('User:', version.rows[0].username);
  console.log('PostgreSQL:', version.rows[0].version);
  console.log('Application tables:', tables.rows.map(r => r.table_name).join(', ') || '(schema not installed yet)');
} catch (err) {
  console.error('Database connection failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
