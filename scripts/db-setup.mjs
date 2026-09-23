import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
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
const migrationPath = path.join(process.cwd(), 'database', 'migrations', '001_create_schema.sql');
const migrationSql = fs.readFileSync(migrationPath, 'utf8');

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(migrationSql);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`INSERT INTO schema_migrations (id) VALUES ('001_create_schema') ON CONFLICT (id) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Database schema installed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
} catch (err) {
  console.error('Database setup failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
