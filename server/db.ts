import pg from 'pg';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  Attendee,
  AttendeeCategory,
  PaymentStatus,
  DashboardStats,
  CreateRegistrationDTO,
  CreateRegistrationResult,
  VerifyQrResult,
  AdminUser,
  PaymentTransaction,
} from './types.js';
import { hashPassword, verifyAttendeeSessionToken } from './auth.js';
import {
  EventSettings,
  getCachedEventSettings,
  setCachedEventSettings,
  getDefaultEventSettings,
} from './eventSettings.js';

// node-postgres normally returns BIGINT/NUMERIC values as strings. The app UI
// expects numbers for dashboard counters and monetary amounts.
pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => parseInt(val, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (val: string) => parseFloat(val));

const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.NETLIFY_DATABASE_URL ||
  '';
const DATABASE_URL_SOURCE = process.env.DATABASE_URL
  ? 'DATABASE_URL'
  : process.env.POSTGRES_URL
    ? 'POSTGRES_URL'
    : process.env.NETLIFY_DATABASE_URL
      ? 'NETLIFY_DATABASE_URL'
      : 'none';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const REQUIRE_DATABASE =
  process.env.REQUIRE_DATABASE === 'true' ||
  process.env.REQUIRE_MYSQL === 'true'; // backward compatibility with the original env template

const LOCAL_STORE_PATH = path.join(process.cwd(), 'database', 'local_store.json');

type DatabaseMode = 'postgres' | 'local';
let databaseMode: DatabaseMode = DATABASE_URL ? 'postgres' : 'local';
let pool: pg.Pool | null = null;
let initPromise: Promise<void> | null = null;

interface LocalStore {
  ticket_counter: number;
  admins: AdminUser[];
  attendees: Attendee[];
  payment_transactions: PaymentTransaction[];
  checkins: Array<{
    id: number;
    attendee_id: number;
    ticket_id: string;
    checked_in_by: string;
    check_in_time: string;
  }>;
  event_settings: EventSettings;
  audit_logs: Array<{
    id: number;
    admin_id?: number | null;
    attendee_id?: number | null;
    action: string;
    details?: string | null;
    ip_address?: string | null;
    created_at: string;
  }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}${crypto.randomBytes(bytes).toString('hex')}`;
}

function normalizeEmail(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value: string): string {
  const digits = String(value || '').replace(/\D/g, '');
  // Treat +91XXXXXXXXXX and XXXXXXXXXX as the same Indian mobile where possible.
  return digits.length > 10 && digits.startsWith('91') ? digits.slice(-10) : digits;
}

function formatRegistrationId(id: number): string {
  return `REG-${String(id).padStart(4, '0')}`;
}

function formatTicketId(sequence: number): string {
  return `FM26-${String(sequence).padStart(3, '0')}`;
}

function ensureLocalStoreShape(value: Partial<LocalStore> | null | undefined): LocalStore {
  const defaults = getDefaultEventSettings();
  return {
    ticket_counter: Number(value?.ticket_counter || 0),
    admins: Array.isArray(value?.admins) ? value!.admins! : [],
    attendees: Array.isArray(value?.attendees) ? value!.attendees! : [],
    payment_transactions: Array.isArray(value?.payment_transactions) ? value!.payment_transactions! : [],
    checkins: Array.isArray(value?.checkins) ? value!.checkins! : [],
    event_settings: value?.event_settings
      ? {
          time: value.event_settings.time || defaults.time,
          venue: value.event_settings.venue || defaults.venue,
          registrationPrice: Number(value.event_settings.registrationPrice || defaults.registrationPrice),
          updatedAt: value.event_settings.updatedAt || defaults.updatedAt,
        }
      : defaults,
    audit_logs: Array.isArray(value?.audit_logs) ? value!.audit_logs! : [],
  };
}

function readLocalStore(): LocalStore {
  try {
    if (fs.existsSync(LOCAL_STORE_PATH)) {
      return ensureLocalStoreShape(JSON.parse(fs.readFileSync(LOCAL_STORE_PATH, 'utf8')));
    }
  } catch (err) {
    console.warn('[DB] Could not read local_store.json; starting from a clean development store.', err);
  }
  return ensureLocalStoreShape(null);
}

function writeLocalStore(store: LocalStore): void {
  if (IS_PRODUCTION) {
    throw new Error('Local JSON database is disabled in production. Configure DATABASE_URL.');
  }
  fs.mkdirSync(path.dirname(LOCAL_STORE_PATH), { recursive: true });
  const tmp = `${LOCAL_STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, LOCAL_STORE_PATH);
}

async function seedPostgres(client: pg.PoolClient): Promise<void> {
  const defaults = getDefaultEventSettings();
  await client.query(
    `INSERT INTO ticket_counter (id, current_number)
     VALUES (1, 0)
     ON CONFLICT (id) DO NOTHING`
  );

  await client.query(
    `INSERT INTO event_settings (id, event_time, venue, registration_price)
     VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [defaults.time, defaults.venue, defaults.registrationPrice]
  );

  const adminEmail = normalizeEmail(process.env.ADMIN_DEFAULT_EMAIL || (IS_PRODUCTION ? '' : 'admin@msap.org'));
  const adminPassword = process.env.ADMIN_DEFAULT_PASSWORD || (IS_PRODUCTION ? '' : 'admin123');
  if (adminEmail && adminPassword) {
    const existing = await client.query('SELECT id FROM admins WHERE LOWER(email) = LOWER($1) LIMIT 1', [adminEmail]);
    if (existing.rowCount === 0) {
      const passwordHash = await hashPassword(adminPassword);
      await client.query(
        `INSERT INTO admins (email, password_hash, role) VALUES ($1, $2, 'ADMIN')`,
        [adminEmail, passwordHash]
      );
      console.log(`[DB] Bootstrapped administrator ${adminEmail}`);
    }
  }
}

function validateDatabaseUrl(connectionString: string): void {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured. Add a hosted PostgreSQL connection string in Vercel Environment Variables.');
  }

  const upper = connectionString.toUpperCase();
  if (
    upper.includes('USER:PASSWORD@HOST') ||
    upper.includes('REPLACE_WITH') ||
    upper.includes('YOUR_DATABASE') ||
    upper.includes('YOUR_PASSWORD')
  ) {
    throw new Error('DATABASE_URL still contains placeholder values. Replace it with the real hosted PostgreSQL connection string.');
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`DATABASE_URL must use postgres:// or postgresql:// (received ${parsed.protocol || 'unknown protocol'}).`);
  }
  if (!parsed.hostname) {
    throw new Error('DATABASE_URL does not contain a database host.');
  }
}


export interface DatabaseHealthResult {
  provider: 'PostgreSQL';
  connected: boolean;
  schemaReady: boolean;
}

/**
 * Lightweight database probe used by /api/health. It deliberately does NOT run
 * migrations or bootstrap data, so a health request can never wait on the
 * migration advisory lock. The probe has its own short connection/query timeout.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealthResult> {
  validateDatabaseUrl(DATABASE_URL);
  const timeout = Math.max(2000, parseInt(process.env.DB_HEALTH_TIMEOUT_MS || '5000', 10) || 5000);
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: timeout,
    query_timeout: timeout,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const result = await client.query(
      `SELECT 1 AS ok, to_regclass('public.attendees')::text AS attendees_table`
    );
    return {
      provider: 'PostgreSQL',
      connected: Number(result.rows[0]?.ok || 0) === 1,
      schemaReady: Boolean(result.rows[0]?.attendees_table),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function initPostgres(): Promise<void> {
  validateDatabaseUrl(DATABASE_URL);
  console.log(`[DB] Initializing PostgreSQL using ${DATABASE_URL_SOURCE}.`);
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    // Keep the per-function pool deliberately small. Vercel may run many
    // concurrent function instances; hosted providers such as Neon should be
    // used with their pooled connection URL where available.
    max: Math.max(1, parseInt(process.env.DB_CONNECTION_LIMIT || '3', 10) || 3),
    connectionTimeoutMillis: Math.max(3000, parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '10000', 10) || 10000),
    idleTimeoutMillis: Math.max(1000, parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000', 10) || 10000),
    allowExitOnIdle: true,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  try {
    await client.query('SELECT 1');

    // Bound SQL/lock waits so a Vercel Function never hangs indefinitely.
    const statementTimeout = Math.max(5000, parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '20000', 10) || 20000);
    const lockTimeout = Math.max(1000, parseInt(process.env.DB_LOCK_TIMEOUT_MS || '5000', 10) || 5000);
    await client.query(`SET statement_timeout = '${statementTimeout}ms'`);
    await client.query(`SET lock_timeout = '${lockTimeout}ms'`);

    // Keep deployment self-contained but avoid repeatedly running DDL on every
    // serverless cold start. Use a non-blocking advisory lock so concurrent
    // cold starts fail fast rather than waiting indefinitely.
    const migrationPath = path.join(process.cwd(), 'database', 'migrations', '001_create_schema.sql');
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Database migration file not found: ${migrationPath}`);
    }
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    const migrationId = '001_create_schema';

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const lockResult = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
      ['msap_freshers_schema_migration']
    );
    const acquiredMigrationLock = Boolean(lockResult.rows[0]?.acquired);
    if (!acquiredMigrationLock) {
      throw new Error('DATABASE_MIGRATION_LOCK_BUSY: another instance is currently initializing the schema; retry shortly.');
    }
    try {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1 LIMIT 1', [migrationId]);
      if ((applied.rowCount || 0) === 0) {
        console.log(`[DB] Applying migration ${migrationId}.`);
        await client.query('BEGIN');
        try {
          await client.query(migrationSql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [migrationId]);
          await client.query('COMMIT');
        } catch (migrationError) {
          await client.query('ROLLBACK');
          throw migrationError;
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, ['msap_freshers_schema_migration']).catch(() => {});
    }

    await seedPostgres(client);

    const settingsRes = await client.query(
      `SELECT event_time, venue, registration_price, updated_at FROM event_settings WHERE id = 1`
    );
    if (settingsRes.rows[0]) {
      setCachedEventSettings({
        time: settingsRes.rows[0].event_time,
        venue: settingsRes.rows[0].venue,
        registrationPrice: Number(settingsRes.rows[0].registration_price),
        updatedAt: new Date(settingsRes.rows[0].updated_at).toISOString(),
      });
    }
  } catch (err) {
    await pool.end().catch(() => {});
    pool = null;
    throw err;
  } finally {
    client.release();
  }
}

async function initLocal(): Promise<void> {
  if (IS_PRODUCTION || REQUIRE_DATABASE) {
    throw new Error('No production database is configured. Set DATABASE_URL to a hosted PostgreSQL database.');
  }

  const store = readLocalStore();
  if (store.admins.length === 0) {
    store.admins.push({
      id: 1,
      email: normalizeEmail(process.env.ADMIN_DEFAULT_EMAIL || 'admin@msap.org'),
      password_hash: await hashPassword(process.env.ADMIN_DEFAULT_PASSWORD || 'admin123'),
      role: 'ADMIN',
      created_at: nowIso(),
    });
  }
  setCachedEventSettings(store.event_settings);
  writeLocalStore(store);
}

/** Initialize the configured storage engine exactly once per warm process. */
export function initDatabase(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      databaseMode = DATABASE_URL ? 'postgres' : 'local';
      if (databaseMode === 'postgres') {
        await initPostgres();
        console.log('[DB] PostgreSQL connection ready.');
      } else {
        await initLocal();
        console.log('[DB] Development JSON store ready.');
      }
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function ensureReady(): Promise<void> {
  await initDatabase();
}

function getPool(): pg.Pool {
  if (!pool) throw new Error('PostgreSQL pool is not initialized.');
  return pool;
}

function attendeeFromRow(row: any): Attendee {
  return {
    ...row,
    id: Number(row.id),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    payment_submitted_at: row.payment_submitted_at
      ? row.payment_submitted_at instanceof Date
        ? row.payment_submitted_at.toISOString()
        : String(row.payment_submitted_at)
      : null,
    payment_confirmed_at: row.payment_confirmed_at
      ? row.payment_confirmed_at instanceof Date
        ? row.payment_confirmed_at.toISOString()
        : String(row.payment_confirmed_at)
      : null,
    check_in_time: row.check_in_time
      ? row.check_in_time instanceof Date
        ? row.check_in_time.toISOString()
        : String(row.check_in_time)
      : null,
  } as Attendee;
}

function paymentFromRow(row: any): PaymentTransaction {
  return {
    ...row,
    id: Number(row.id),
    registration_id: Number(row.registration_id),
    amount: Number(row.amount),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    paid_at: row.paid_at
      ? row.paid_at instanceof Date
        ? row.paid_at.toISOString()
        : String(row.paid_at)
      : null,
  } as PaymentTransaction;
}

async function insertAuditLog(params: {
  adminId?: number | null;
  attendeeId?: number | null;
  action: string;
  details?: string | null;
  ipAddress?: string | null;
  client?: pg.PoolClient;
}): Promise<void> {
  if (databaseMode === 'postgres') {
    const executor = params.client || getPool();
    await executor.query(
      `INSERT INTO audit_logs (admin_id, attendee_id, action, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [params.adminId ?? null, params.attendeeId ?? null, params.action, params.details ?? null, params.ipAddress ?? null]
    );
    return;
  }

  const store = readLocalStore();
  store.audit_logs.push({
    id: (store.audit_logs.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) || 0) + 1,
    admin_id: params.adminId ?? null,
    attendee_id: params.attendeeId ?? null,
    action: params.action,
    details: params.details ?? null,
    ip_address: params.ipAddress ?? null,
    created_at: nowIso(),
  });
  writeLocalStore(store);
}

export function isUsingMySQL(): boolean {
  // Kept for backward compatibility with the route name used by the original code.
  return false;
}

export function getDatabaseProvider(): 'PostgreSQL' | 'Local development JSON' {
  return databaseMode === 'postgres' ? 'PostgreSQL' : 'Local development JSON';
}

export async function createAttendee(dto: CreateRegistrationDTO): Promise<CreateRegistrationResult> {
  await ensureReady();

  const fullName = String(dto.fullName || '').trim();
  const phone = String(dto.phone || '').trim();
  const email = normalizeEmail(dto.email);
  const college = String(dto.college || 'MSAP Architecture & Planning').trim();
  const category: AttendeeCategory = dto.category === 'SENIOR' ? 'SENIOR' : 'FRESHER';
  const phoneKey = normalizePhone(phone);

  if (!fullName || !phoneKey || !email) {
    throw new Error('Full name, phone number and email are required.');
  }

  if (databaseMode === 'postgres') {
    const db = getPool();

    if (dto.googleResponseId) {
      const g = await db.query(`SELECT * FROM attendees WHERE google_response_id = $1 LIMIT 1`, [dto.googleResponseId]);
      if (g.rows[0]) return { attendee: attendeeFromRow(g.rows[0]), isDuplicate: true };
    }

    const duplicateRes = await db.query(
      `SELECT * FROM attendees
       WHERE regexp_replace(phone, '[^0-9]', '', 'g') IN ($1, $2)
          OR LOWER(email) = LOWER($3)
       ORDER BY id DESC`,
      [phoneKey, `91${phoneKey}`, email]
    );

    if (duplicateRes.rows.length > 0) {
      const exact = duplicateRes.rows.find((row: any) => {
        const existingPhone = normalizePhone(row.phone);
        return existingPhone === phoneKey && normalizeEmail(row.email) === email;
      });
      if (exact) {
        return { attendee: attendeeFromRow(exact), isDuplicate: true };
      }
      return {
        isDuplicate: false,
        isPartialDuplicate: true,
        message: 'A registration already exists with this mobile number or email. Please use Retrieve Existing Pass.',
      };
    }

    if (dto.paymentUtr) {
      const utr = String(dto.paymentUtr).trim().replace(/\s+/g, '');
      const utrExisting = await db.query(`SELECT id FROM attendees WHERE payment_utr = $1 LIMIT 1`, [utr]);
      if ((utrExisting.rowCount || 0) > 0) {
        return { isDuplicate: false, isPartialDuplicate: true, message: 'This payment reference has already been submitted.' };
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const accessToken = randomToken('acc_');
      const insertRes = await client.query(
        `INSERT INTO attendees (
          full_name, phone, email, college, course_class, academic_year, category,
          payment_status, entry_pass_status, ticket_status, registration_status,
          qr_token, access_token, check_in_status, google_response_id, student_roll_id,
          payment_utr, payment_submitted_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, 'NOT_CREATED', 'NOT_GENERATED', 'REGISTERED',
          NULL, $9, 'NOT_CHECKED_IN', $10, $11,
          $12, CASE WHEN $12::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END
        ) RETURNING *`,
        [
          fullName,
          phone,
          email,
          college,
          dto.courseClass?.trim() || null,
          dto.academicYear?.trim() || null,
          category,
          dto.paymentUtr ? 'PAYMENT_SUBMITTED' : 'PENDING',
          accessToken,
          dto.googleResponseId?.trim() || null,
          dto.rollId?.trim() || null,
          dto.paymentUtr?.trim().replace(/\s+/g, '') || null,
        ]
      );
      const id = Number(insertRes.rows[0].id);
      const registrationId = formatRegistrationId(id);
      const updateRes = await client.query(
        `UPDATE attendees SET registration_id = $1 WHERE id = $2 RETURNING *`,
        [registrationId, id]
      );
      await insertAuditLog({
        attendeeId: id,
        action: 'REGISTRATION_CREATED',
        details: `New registration created: ${registrationId} for ${fullName} (${category})`,
        client,
      });
      await client.query('COMMIT');
      return { attendee: attendeeFromRow(updateRes.rows[0]), isDuplicate: false };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const store = readLocalStore();
  if (dto.googleResponseId) {
    const g = store.attendees.find((a) => a.google_response_id === dto.googleResponseId);
    if (g) return { attendee: g, isDuplicate: true };
  }
  const samePhone = store.attendees.find((a) => normalizePhone(a.phone) === phoneKey);
  const sameEmail = store.attendees.find((a) => normalizeEmail(a.email) === email);
  const exact = store.attendees.find((a) => normalizePhone(a.phone) === phoneKey && normalizeEmail(a.email) === email);
  if (exact) return { attendee: exact, isDuplicate: true };
  if (samePhone || sameEmail) {
    return {
      isDuplicate: false,
      isPartialDuplicate: true,
      message: 'A registration already exists with this mobile number or email. Please use Retrieve Existing Pass.',
    };
  }

  const id = Math.max(0, ...store.attendees.map((a) => Number(a.id) || 0)) + 1;
  const createdAt = nowIso();
  const attendee: Attendee = {
    id,
    registration_id: formatRegistrationId(id),
    ticket_id: null,
    full_name: fullName,
    phone,
    email,
    college,
    course_class: dto.courseClass?.trim() || null,
    academic_year: dto.academicYear?.trim() || null,
    category,
    payment_status: dto.paymentUtr ? 'PAYMENT_SUBMITTED' : 'PENDING',
    entry_pass_status: 'NOT_CREATED',
    ticket_status: 'NOT_GENERATED',
    registration_status: 'REGISTERED',
    qr_token: null,
    access_token: randomToken('acc_'),
    check_in_status: 'NOT_CHECKED_IN',
    google_response_id: dto.googleResponseId?.trim() || null,
    student_roll_id: dto.rollId?.trim() || null,
    payment_utr: dto.paymentUtr?.trim().replace(/\s+/g, '') || null,
    payment_submitted_at: dto.paymentUtr ? createdAt : null,
    payment_confirmed_at: null,
    payment_confirmed_by: null,
    rejection_reason: null,
    check_in_time: null,
    checked_in_by: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  store.attendees.unshift(attendee);
  store.audit_logs.push({
    id: Math.max(0, ...store.audit_logs.map((x) => Number(x.id) || 0)) + 1,
    attendee_id: id,
    action: 'REGISTRATION_CREATED',
    details: `New registration created: ${attendee.registration_id} for ${fullName} (${category})`,
    created_at: createdAt,
  });
  writeLocalStore(store);
  return { attendee, isDuplicate: false };
}

export async function getAttendeeById(id: number): Promise<Attendee | null> {
  await ensureReady();
  if (!Number.isFinite(id)) return null;
  if (databaseMode === 'postgres') {
    const result = await getPool().query(`SELECT * FROM attendees WHERE id = $1 LIMIT 1`, [id]);
    return result.rows[0] ? attendeeFromRow(result.rows[0]) : null;
  }
  return readLocalStore().attendees.find((a) => Number(a.id) === Number(id)) || null;
}

export async function getAttendeeByAccessToken(token: string): Promise<Attendee | null> {
  await ensureReady();
  const candidate = String(token || '').trim();
  if (!candidate) return null;

  const session = verifyAttendeeSessionToken(candidate);
  if (session) {
    const attendee = await getAttendeeById(Number(session.attendeeId));
    if (attendee && attendee.registration_id === session.registrationId) return attendee;
    return null;
  }

  if (databaseMode === 'postgres') {
    const result = await getPool().query(`SELECT * FROM attendees WHERE access_token = $1 LIMIT 1`, [candidate]);
    return result.rows[0] ? attendeeFromRow(result.rows[0]) : null;
  }
  return readLocalStore().attendees.find((a) => a.access_token === candidate) || null;
}

export async function lookupAttendee(phone: string): Promise<Attendee | null> {
  await ensureReady();
  const phoneKey = normalizePhone(phone);
  if (!phoneKey) return null;
  if (databaseMode === 'postgres') {
    const result = await getPool().query(
      `SELECT * FROM attendees
       WHERE regexp_replace(phone, '[^0-9]', '', 'g') IN ($1, $2)
       ORDER BY id DESC LIMIT 1`,
      [phoneKey, `91${phoneKey}`]
    );
    return result.rows[0] ? attendeeFromRow(result.rows[0]) : null;
  }
  return readLocalStore().attendees.find((a) => normalizePhone(a.phone) === phoneKey) || null;
}

export async function lookupAttendeeSecure(phone: string, key: string): Promise<Attendee | null> {
  await ensureReady();
  const phoneKey = normalizePhone(phone);
  const lookupKey = String(key || '').trim().toLowerCase();
  if (!phoneKey || !lookupKey) return null;

  if (databaseMode === 'postgres') {
    const result = await getPool().query(
      `SELECT * FROM attendees
       WHERE regexp_replace(phone, '[^0-9]', '', 'g') IN ($1, $2)
         AND (LOWER(email) = $3 OR LOWER(COALESCE(student_roll_id, '')) = $3)
       ORDER BY id DESC LIMIT 1`,
      [phoneKey, `91${phoneKey}`, lookupKey]
    );
    return result.rows[0] ? attendeeFromRow(result.rows[0]) : null;
  }
  return (
    readLocalStore().attendees.find(
      (a) =>
        normalizePhone(a.phone) === phoneKey &&
        (normalizeEmail(a.email) === lookupKey || String(a.student_roll_id || '').trim().toLowerCase() === lookupKey)
    ) || null
  );
}

export async function findAdminByEmail(email: string): Promise<AdminUser | null> {
  await ensureReady();
  const key = normalizeEmail(email);
  if (!key) return null;
  if (databaseMode === 'postgres') {
    const result = await getPool().query(`SELECT * FROM admins WHERE LOWER(email) = $1 LIMIT 1`, [key]);
    return result.rows[0]
      ? {
          ...result.rows[0],
          id: Number(result.rows[0].id),
          created_at:
            result.rows[0].created_at instanceof Date
              ? result.rows[0].created_at.toISOString()
              : String(result.rows[0].created_at),
        }
      : null;
  }
  return readLocalStore().admins.find((a) => normalizeEmail(a.email) === key) || null;
}

export async function createPaymentTransaction(params: {
  registrationId: number;
  gatewayProvider: string;
  gatewayOrderId: string;
  amount: number;
  currency: string;
}): Promise<PaymentTransaction> {
  await ensureReady();
  if (databaseMode === 'postgres') {
    const existing = await getPool().query(
      `SELECT * FROM payment_transactions WHERE gateway_order_id = $1 ORDER BY id DESC LIMIT 1`,
      [params.gatewayOrderId]
    );
    if (existing.rows[0]) return paymentFromRow(existing.rows[0]);
    const result = await getPool().query(
      `INSERT INTO payment_transactions
       (registration_id, gateway_provider, gateway_order_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING') RETURNING *`,
      [params.registrationId, params.gatewayProvider, params.gatewayOrderId, params.amount, params.currency]
    );
    return paymentFromRow(result.rows[0]);
  }

  const store = readLocalStore();
  const existing = store.payment_transactions.find((x) => x.gateway_order_id === params.gatewayOrderId);
  if (existing) return existing;
  const now = nowIso();
  const tx: PaymentTransaction = {
    id: Math.max(0, ...store.payment_transactions.map((x) => Number(x.id) || 0)) + 1,
    registration_id: params.registrationId,
    gateway_provider: params.gatewayProvider,
    gateway_order_id: params.gatewayOrderId,
    gateway_payment_id: null,
    gateway_signature: null,
    amount: Number(params.amount),
    currency: params.currency,
    payment_method: null,
    status: 'PENDING',
    gateway_event_id: null,
    paid_at: null,
    created_at: now,
    updated_at: now,
  };
  store.payment_transactions.push(tx);
  writeLocalStore(store);
  return tx;
}

export async function getPaymentTransactionByOrderId(orderId: string): Promise<PaymentTransaction | null> {
  await ensureReady();
  if (databaseMode === 'postgres') {
    const result = await getPool().query(
      `SELECT * FROM payment_transactions WHERE gateway_order_id = $1 ORDER BY id DESC LIMIT 1`,
      [orderId]
    );
    return result.rows[0] ? paymentFromRow(result.rows[0]) : null;
  }
  return readLocalStore().payment_transactions.find((x) => x.gateway_order_id === orderId) || null;
}

export async function getLatestPaymentTransactionByRegistrationId(registrationId: number): Promise<PaymentTransaction | null> {
  await ensureReady();
  if (databaseMode === 'postgres') {
    const result = await getPool().query(
      `SELECT * FROM payment_transactions WHERE registration_id = $1 ORDER BY id DESC LIMIT 1`,
      [registrationId]
    );
    return result.rows[0] ? paymentFromRow(result.rows[0]) : null;
  }
  const list = readLocalStore().payment_transactions
    .filter((x) => Number(x.registration_id) === Number(registrationId))
    .sort((a, b) => Number(b.id) - Number(a.id));
  return list[0] || null;
}

export async function markPaymentSuccessfulAndGeneratePass(params: {
  registrationId: number;
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  gatewaySignature?: string;
  paymentMethod?: string;
  confirmedBy?: string;
  eventId?: string;
  isManualOverride?: boolean;
}): Promise<{ attendee: Attendee; isNewPass: boolean }> {
  await ensureReady();

  if (databaseMode === 'postgres') {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const attendeeRes = await client.query(`SELECT * FROM attendees WHERE id = $1 FOR UPDATE`, [params.registrationId]);
      if (!attendeeRes.rows[0]) throw new Error('Attendee registration not found.');
      const current = attendeeFromRow(attendeeRes.rows[0]);

      const alreadyHasPass =
        current.payment_status === 'PAID' &&
        current.entry_pass_status === 'ACTIVE' &&
        !!current.ticket_id &&
        !!current.qr_token;

      if (alreadyHasPass) {
        if (params.gatewayOrderId) {
          await client.query(
            `UPDATE payment_transactions
             SET status = 'PAID', gateway_payment_id = COALESCE($2, gateway_payment_id),
                 gateway_signature = COALESCE($3, gateway_signature), payment_method = COALESCE($4, payment_method),
                 gateway_event_id = COALESCE($5, gateway_event_id), paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
             WHERE gateway_order_id = $1`,
            [params.gatewayOrderId, params.gatewayPaymentId || null, params.gatewaySignature || null, params.paymentMethod || null, params.eventId || null]
          );
        }
        await client.query('COMMIT');
        return { attendee: current, isNewPass: false };
      }

      const counterRes = await client.query(
        `UPDATE ticket_counter SET current_number = current_number + 1 WHERE id = 1 RETURNING current_number`
      );
      if (!counterRes.rows[0]) {
        await client.query(`INSERT INTO ticket_counter (id, current_number) VALUES (1, 1) ON CONFLICT (id) DO NOTHING`);
      }
      const sequence = counterRes.rows[0] ? Number(counterRes.rows[0].current_number) : 1;
      const ticketId = current.ticket_id || formatTicketId(sequence);
      const qrToken = current.qr_token || randomToken('msap_qr_', 32);
      const confirmedBy = params.confirmedBy || (params.isManualOverride ? 'MANUAL_ADMIN_OVERRIDE' : 'PAYMENT_VERIFIED');

      const updatedRes = await client.query(
        `UPDATE attendees SET
          payment_status = 'PAID',
          entry_pass_status = 'ACTIVE',
          ticket_status = CASE WHEN ticket_status = 'USED' THEN 'USED' ELSE 'UNUSED' END,
          ticket_id = $2,
          qr_token = $3,
          payment_confirmed_at = CURRENT_TIMESTAMP,
          payment_confirmed_by = $4,
          rejection_reason = NULL,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [params.registrationId, ticketId, qrToken, confirmedBy]
      );

      if (params.gatewayOrderId) {
        await client.query(
          `UPDATE payment_transactions SET
             status = 'PAID',
             gateway_payment_id = COALESCE($2, gateway_payment_id),
             gateway_signature = COALESCE($3, gateway_signature),
             payment_method = COALESCE($4, payment_method),
             gateway_event_id = COALESCE($5, gateway_event_id),
             paid_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE gateway_order_id = $1`,
          [params.gatewayOrderId, params.gatewayPaymentId || null, params.gatewaySignature || null, params.paymentMethod || null, params.eventId || null]
        );
      }

      await insertAuditLog({
        attendeeId: params.registrationId,
        action: params.isManualOverride ? 'PAYMENT_MANUAL_OVERRIDE' : 'PAYMENT_CONFIRMED',
        details: `Payment confirmed and pass ${ticketId} activated by ${confirmedBy}.`,
        client,
      });
      await client.query('COMMIT');
      return { attendee: attendeeFromRow(updatedRes.rows[0]), isNewPass: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const store = readLocalStore();
  const attendee = store.attendees.find((a) => Number(a.id) === Number(params.registrationId));
  if (!attendee) throw new Error('Attendee registration not found.');
  const alreadyHasPass = attendee.payment_status === 'PAID' && attendee.entry_pass_status === 'ACTIVE' && !!attendee.ticket_id && !!attendee.qr_token;
  if (!alreadyHasPass) {
    store.ticket_counter = Number(store.ticket_counter || 0) + 1;
    attendee.ticket_id = attendee.ticket_id || formatTicketId(store.ticket_counter);
    attendee.qr_token = attendee.qr_token || randomToken('msap_qr_', 32);
    attendee.payment_status = 'PAID';
    attendee.entry_pass_status = 'ACTIVE';
    attendee.ticket_status = attendee.ticket_status === 'USED' ? 'USED' : 'UNUSED';
    attendee.payment_confirmed_at = nowIso();
    attendee.payment_confirmed_by = params.confirmedBy || (params.isManualOverride ? 'MANUAL_ADMIN_OVERRIDE' : 'PAYMENT_VERIFIED');
    attendee.rejection_reason = null;
    attendee.updated_at = nowIso();
  }
  if (params.gatewayOrderId) {
    const tx = store.payment_transactions.find((x) => x.gateway_order_id === params.gatewayOrderId);
    if (tx) {
      tx.status = 'PAID';
      tx.gateway_payment_id = params.gatewayPaymentId || tx.gateway_payment_id || null;
      tx.gateway_signature = params.gatewaySignature || tx.gateway_signature || null;
      tx.payment_method = params.paymentMethod || tx.payment_method || null;
      tx.gateway_event_id = params.eventId || tx.gateway_event_id || null;
      tx.paid_at = tx.paid_at || nowIso();
      tx.updated_at = nowIso();
    }
  }
  writeLocalStore(store);
  return { attendee, isNewPass: !alreadyHasPass };
}

export async function markPaymentFailed(params: {
  registrationId: number;
  gatewayOrderId?: string;
  status: 'FAILED' | 'EXPIRED';
}): Promise<void> {
  await ensureReady();
  if (databaseMode === 'postgres') {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      if (params.gatewayOrderId) {
        await client.query(
          `UPDATE payment_transactions SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE gateway_order_id = $1`,
          [params.gatewayOrderId, params.status]
        );
      }
      await client.query(
        `UPDATE attendees SET payment_status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND payment_status <> 'PAID'`,
        [params.registrationId, params.status]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return;
  }
  const store = readLocalStore();
  const attendee = store.attendees.find((a) => Number(a.id) === Number(params.registrationId));
  if (attendee && attendee.payment_status !== 'PAID') {
    attendee.payment_status = params.status;
    attendee.updated_at = nowIso();
  }
  if (params.gatewayOrderId) {
    const tx = store.payment_transactions.find((x) => x.gateway_order_id === params.gatewayOrderId);
    if (tx) {
      tx.status = params.status;
      tx.updated_at = nowIso();
    }
  }
  writeLocalStore(store);
}

export async function getEventSettings(): Promise<EventSettings> {
  await ensureReady();
  if (databaseMode === 'postgres') {
    const result = await getPool().query(
      `SELECT event_time, venue, registration_price, updated_at FROM event_settings WHERE id = 1 LIMIT 1`
    );
    if (!result.rows[0]) return getCachedEventSettings();
    return setCachedEventSettings({
      time: result.rows[0].event_time,
      venue: result.rows[0].venue,
      registrationPrice: Number(result.rows[0].registration_price),
      updatedAt:
        result.rows[0].updated_at instanceof Date
          ? result.rows[0].updated_at.toISOString()
          : String(result.rows[0].updated_at),
    });
  }
  const store = readLocalStore();
  return setCachedEventSettings(store.event_settings);
}

export async function updateEventSettings(params: {
  time: string;
  venue: string;
  registrationPrice: number | string;
  adminId?: number;
  adminEmail?: string;
  ipAddress?: string;
}): Promise<EventSettings> {
  await ensureReady();
  const time = String(params.time || '').trim();
  const venue = String(params.venue || '').trim();
  const price = Number(params.registrationPrice);
  if (!time || !venue || !Number.isFinite(price) || price <= 0) {
    throw new Error('Time, venue and a positive registration price are required.');
  }

  if (databaseMode === 'postgres') {
    const result = await getPool().query(
      `UPDATE event_settings SET event_time = $1, venue = $2, registration_price = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1 RETURNING event_time, venue, registration_price, updated_at`,
      [time, venue, price]
    );
    const row = result.rows[0];
    const settings = setCachedEventSettings({
      time: row.event_time,
      venue: row.venue,
      registrationPrice: Number(row.registration_price),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    });
    await insertAuditLog({
      adminId: params.adminId,
      action: 'EVENT_SETTINGS_UPDATED',
      details: `Event settings updated by ${params.adminEmail || 'admin'}: time=${time}, venue=${venue}, price=${price}`,
      ipAddress: params.ipAddress,
    });
    return settings;
  }

  const store = readLocalStore();
  store.event_settings = { time, venue, registrationPrice: price, updatedAt: nowIso() };
  writeLocalStore(store);
  return setCachedEventSettings(store.event_settings);
}

export async function submitPaymentUtr(params: { identifier: string; paymentUtr: string }): Promise<Attendee> {
  await ensureReady();
  const attendee = await getAttendeeByAccessToken(params.identifier);
  if (!attendee) throw new Error('Attendee registration record not found or session expired.');
  if (attendee.payment_status === 'PAID') return attendee;

  const utr = String(params.paymentUtr || '').trim().replace(/\s+/g, '');
  if (!/^\d{12}$/.test(utr)) throw new Error('Please enter a valid 12-digit numeric UPI transaction reference (UTR).');

  if (databaseMode === 'postgres') {
    const duplicate = await getPool().query(`SELECT id FROM attendees WHERE payment_utr = $1 AND id <> $2 LIMIT 1`, [utr, attendee.id]);
    if ((duplicate.rowCount || 0) > 0) {
      const err: any = new Error('This transaction reference has already been submitted.');
      err.statusCode = 409;
      throw err;
    }
    const result = await getPool().query(
      `UPDATE attendees SET
         payment_utr = $2,
         payment_status = 'PAYMENT_SUBMITTED',
         payment_submitted_at = CURRENT_TIMESTAMP,
         rejection_reason = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [attendee.id, utr]
    );
    await insertAuditLog({
      attendeeId: attendee.id,
      action: 'PAYMENT_UTR_SUBMITTED',
      details: `UPI UTR ${utr.slice(0, 4)}••••${utr.slice(-4)} submitted for admin verification.`,
    });
    return attendeeFromRow(result.rows[0]);
  }

  const store = readLocalStore();
  if (store.attendees.some((a) => a.id !== attendee.id && a.payment_utr === utr)) {
    const err: any = new Error('This transaction reference has already been submitted.');
    err.statusCode = 409;
    throw err;
  }
  const target = store.attendees.find((a) => a.id === attendee.id)!;
  target.payment_utr = utr;
  target.payment_status = 'PAYMENT_SUBMITTED';
  target.payment_submitted_at = nowIso();
  target.rejection_reason = null;
  target.updated_at = nowIso();
  writeLocalStore(store);
  return target;
}

export async function verifyPaymentAdmin(params: {
  attendeeId: number;
  adminEmail: string;
  adminId: number;
}): Promise<{ attendee: Attendee; isNewPass: boolean }> {
  const attendee = await getAttendeeById(params.attendeeId);
  if (!attendee) throw new Error('Attendee record not found.');
  if (!attendee.payment_utr && attendee.payment_status !== 'PAID') {
    throw new Error('No submitted UPI transaction reference is available for verification.');
  }
  const result = await markPaymentSuccessfulAndGeneratePass({
    registrationId: params.attendeeId,
    paymentMethod: 'upi_qr',
    confirmedBy: params.adminEmail,
  });
  await insertAuditLog({
    adminId: params.adminId,
    attendeeId: params.attendeeId,
    action: 'ADMIN_PAYMENT_VERIFIED',
    details: `UPI payment verified by ${params.adminEmail}. Ticket ${result.attendee.ticket_id} issued.`,
  });
  return result;
}

export async function rejectPaymentAdmin(params: {
  attendeeId: number;
  adminEmail: string;
  adminId: number;
  reason?: string;
}): Promise<Attendee> {
  await ensureReady();
  const reason = params.reason || 'Payment reference could not be verified.';

  if (databaseMode === 'postgres') {
    const existing = await getAttendeeById(params.attendeeId);
    if (!existing) throw new Error('Attendee record not found.');
    if (existing.payment_status === 'PAID') throw new Error('A paid ticket cannot be rejected. Use the refund action instead.');
    const previousUtr = existing.payment_utr;
    const result = await getPool().query(
      `UPDATE attendees SET
         payment_status = 'REJECTED',
         rejection_reason = $2,
         payment_utr = NULL,
         payment_submitted_at = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [params.attendeeId, reason]
    );
    await insertAuditLog({
      adminId: params.adminId,
      attendeeId: params.attendeeId,
      action: 'ADMIN_PAYMENT_REJECTED',
      details: `Payment UTR ${previousUtr || '(none)'} rejected by ${params.adminEmail}. Reason: ${reason}`,
    });
    return attendeeFromRow(result.rows[0]);
  }

  const store = readLocalStore();
  const attendee = store.attendees.find((a) => a.id === params.attendeeId);
  if (!attendee) throw new Error('Attendee record not found.');
  if (attendee.payment_status === 'PAID') throw new Error('A paid ticket cannot be rejected. Use the refund action instead.');
  const previousUtr = attendee.payment_utr;
  attendee.payment_status = 'REJECTED';
  attendee.rejection_reason = reason;
  attendee.payment_utr = null;
  attendee.payment_submitted_at = null;
  attendee.updated_at = nowIso();
  store.audit_logs.push({
    id: Math.max(0, ...store.audit_logs.map((x) => x.id)) + 1,
    admin_id: params.adminId,
    attendee_id: params.attendeeId,
    action: 'ADMIN_PAYMENT_REJECTED',
    details: `Payment UTR ${previousUtr || '(none)'} rejected by ${params.adminEmail}. Reason: ${reason}`,
    created_at: nowIso(),
  });
  writeLocalStore(store);
  return attendee;
}

export async function confirmPaymentManualOverride(params: {
  attendeeId: number;
  adminId: number;
  adminEmail: string;
  reason: string;
}): Promise<Attendee | null> {
  const existing = await getAttendeeById(params.attendeeId);
  if (!existing) return null;
  const result = await markPaymentSuccessfulAndGeneratePass({
    registrationId: params.attendeeId,
    paymentMethod: 'manual_override',
    confirmedBy: params.adminEmail,
    isManualOverride: true,
  });
  await insertAuditLog({
    adminId: params.adminId,
    attendeeId: params.attendeeId,
    action: 'MANUAL_PAYMENT_OVERRIDE',
    details: `Manual payment override by ${params.adminEmail}. Reason: ${params.reason}`,
  });
  return result.attendee;
}

export async function refundPaymentAndRevokePass(params: {
  attendeeId: number;
  adminId: number;
  adminEmail: string;
  reason: string;
}): Promise<{ attendee: Attendee }> {
  await ensureReady();

  if (databaseMode === 'postgres') {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const existingRes = await client.query(`SELECT * FROM attendees WHERE id = $1 FOR UPDATE`, [params.attendeeId]);
      if (!existingRes.rows[0]) throw new Error('Attendee record not found.');
      const updatedRes = await client.query(
        `UPDATE attendees SET
           payment_status = 'REFUNDED',
           entry_pass_status = 'REVOKED',
           ticket_status = 'REVOKED',
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [params.attendeeId]
      );
      await client.query(
        `UPDATE payment_transactions SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id FROM payment_transactions WHERE registration_id = $1 ORDER BY id DESC LIMIT 1
         )`,
        [params.attendeeId]
      );
      await insertAuditLog({
        adminId: params.adminId,
        attendeeId: params.attendeeId,
        action: 'PAYMENT_REFUNDED_PASS_REVOKED',
        details: `Refund and pass revocation by ${params.adminEmail}. Reason: ${params.reason}`,
        client,
      });
      await client.query('COMMIT');
      return { attendee: attendeeFromRow(updatedRes.rows[0]) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const store = readLocalStore();
  const attendee = store.attendees.find((a) => a.id === params.attendeeId);
  if (!attendee) throw new Error('Attendee record not found.');
  attendee.payment_status = 'REFUNDED';
  attendee.entry_pass_status = 'REVOKED';
  attendee.ticket_status = 'REVOKED';
  attendee.updated_at = nowIso();
  const tx = store.payment_transactions
    .filter((x) => x.registration_id === attendee.id)
    .sort((a, b) => b.id - a.id)[0];
  if (tx) {
    tx.status = 'REFUNDED';
    tx.updated_at = nowIso();
  }
  writeLocalStore(store);
  return { attendee };
}

function qrAttendeePayload(attendee: Attendee): VerifyQrResult['attendee'] {
  return {
    id: attendee.id,
    registration_id: attendee.registration_id,
    ticket_id: attendee.ticket_id,
    full_name: attendee.full_name,
    category: attendee.category,
    college: attendee.college,
    course_class: attendee.course_class,
    academic_year: attendee.academic_year,
    phone: attendee.phone,
    email: attendee.email,
    payment_status: attendee.payment_status,
    entry_pass_status: attendee.entry_pass_status,
    ticket_status: attendee.ticket_status,
    check_in_status: attendee.check_in_status,
    check_in_time: attendee.check_in_time,
    checked_in_by: attendee.checked_in_by,
    payment_confirmed_at: attendee.payment_confirmed_at,
  };
}

export async function verifyQrToken(qrToken: string): Promise<VerifyQrResult> {
  await ensureReady();
  const token = String(qrToken || '').trim();
  if (!token) return { status: 'INVALID', message: 'QR token is missing.' };

  let attendee: Attendee | null = null;
  if (databaseMode === 'postgres') {
    const result = await getPool().query(`SELECT * FROM attendees WHERE qr_token = $1 LIMIT 1`, [token]);
    attendee = result.rows[0] ? attendeeFromRow(result.rows[0]) : null;
  } else {
    attendee = readLocalStore().attendees.find((a) => a.qr_token === token) || null;
  }
  if (!attendee) return { status: 'INVALID', message: 'Invalid or unknown entry-pass QR code.' };
  if (attendee.payment_status !== 'PAID') {
    return { status: 'PAYMENT_NOT_CONFIRMED', message: 'Payment is not confirmed for this registration.', attendee: qrAttendeePayload(attendee) };
  }
  if (attendee.entry_pass_status === 'REVOKED' || attendee.ticket_status === 'REVOKED') {
    return { status: 'ENTRY_PASS_REVOKED', message: 'This entry pass has been revoked.', attendee: qrAttendeePayload(attendee) };
  }
  if (attendee.check_in_status === 'CHECKED_IN' || attendee.entry_pass_status === 'CHECKED_IN' || attendee.ticket_status === 'USED') {
    return { status: 'ALREADY_CHECKED_IN', message: 'This ticket has already been used for entry.', attendee: qrAttendeePayload(attendee) };
  }
  return { status: 'VALID', message: 'Valid paid entry pass. Ready for check-in.', attendee: qrAttendeePayload(attendee) };
}

export async function performCheckIn(attendeeId: number, checkedInBy: string): Promise<any> {
  await ensureReady();

  if (databaseMode === 'postgres') {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT * FROM attendees WHERE id = $1 FOR UPDATE`, [attendeeId]);
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return { success: false, status: 'INVALID', message: 'Attendee not found.' };
      }
      const attendee = attendeeFromRow(result.rows[0]);
      if (attendee.payment_status !== 'PAID') {
        await client.query('ROLLBACK');
        return { success: false, status: 'PAYMENT_NOT_CONFIRMED', message: 'Payment is not confirmed.', attendee: qrAttendeePayload(attendee) };
      }
      if (attendee.entry_pass_status === 'REVOKED' || attendee.ticket_status === 'REVOKED') {
        await client.query('ROLLBACK');
        return { success: false, status: 'ENTRY_PASS_REVOKED', message: 'Entry pass has been revoked.', attendee: qrAttendeePayload(attendee) };
      }
      if (attendee.check_in_status === 'CHECKED_IN' || attendee.entry_pass_status === 'CHECKED_IN' || attendee.ticket_status === 'USED') {
        await client.query('ROLLBACK');
        return { success: false, status: 'ALREADY_CHECKED_IN', message: 'Ticket has already been checked in.', attendee: qrAttendeePayload(attendee) };
      }
      if (!attendee.ticket_id) throw new Error('Paid attendee does not have a ticket ID.');

      await client.query(
        `INSERT INTO checkins (attendee_id, ticket_id, checked_in_by) VALUES ($1, $2, $3)`,
        [attendee.id, attendee.ticket_id, checkedInBy]
      );
      const updated = await client.query(
        `UPDATE attendees SET
           check_in_status = 'CHECKED_IN',
           entry_pass_status = 'CHECKED_IN',
           ticket_status = 'USED',
           check_in_time = CURRENT_TIMESTAMP,
           checked_in_by = $2,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [attendee.id, checkedInBy]
      );
      await insertAuditLog({
        attendeeId: attendee.id,
        action: 'CHECK_IN',
        details: `Ticket ${attendee.ticket_id} checked in by ${checkedInBy}.`,
        client,
      });
      await client.query('COMMIT');
      const updatedAttendee = attendeeFromRow(updated.rows[0]);
      return { success: true, status: 'CHECKED_IN', message: `Entry confirmed for ${updatedAttendee.full_name}.`, attendee: qrAttendeePayload(updatedAttendee) };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  const store = readLocalStore();
  const attendee = store.attendees.find((a) => a.id === attendeeId);
  if (!attendee) return { success: false, status: 'INVALID', message: 'Attendee not found.' };
  if (attendee.payment_status !== 'PAID') return { success: false, status: 'PAYMENT_NOT_CONFIRMED', message: 'Payment is not confirmed.', attendee: qrAttendeePayload(attendee) };
  if (attendee.entry_pass_status === 'REVOKED' || attendee.ticket_status === 'REVOKED') return { success: false, status: 'ENTRY_PASS_REVOKED', message: 'Entry pass has been revoked.', attendee: qrAttendeePayload(attendee) };
  if (attendee.check_in_status === 'CHECKED_IN') return { success: false, status: 'ALREADY_CHECKED_IN', message: 'Ticket has already been checked in.', attendee: qrAttendeePayload(attendee) };
  attendee.check_in_status = 'CHECKED_IN';
  attendee.entry_pass_status = 'CHECKED_IN';
  attendee.ticket_status = 'USED';
  attendee.check_in_time = nowIso();
  attendee.checked_in_by = checkedInBy;
  attendee.updated_at = nowIso();
  store.checkins.push({
    id: Math.max(0, ...store.checkins.map((x) => x.id)) + 1,
    attendee_id: attendee.id,
    ticket_id: attendee.ticket_id || '',
    checked_in_by: checkedInBy,
    check_in_time: attendee.check_in_time,
  });
  writeLocalStore(store);
  return { success: true, status: 'CHECKED_IN', message: `Entry confirmed for ${attendee.full_name}.`, attendee: qrAttendeePayload(attendee) };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  await ensureReady();
  if (databaseMode === 'postgres') {
    const result = await getPool().query(`
      SELECT
        COUNT(*)::int AS total_registered,
        COUNT(*) FILTER (WHERE payment_status = 'PENDING')::int AS pending_payments,
        COUNT(*) FILTER (WHERE payment_status = 'PAYMENT_SUBMITTED')::int AS submitted_payments,
        COUNT(*) FILTER (WHERE payment_status = 'PROCESSING')::int AS processing_payments,
        COUNT(*) FILTER (WHERE payment_status IN ('PAID','VERIFIED'))::int AS successful_payments,
        COUNT(*) FILTER (WHERE payment_status = 'REJECTED')::int AS rejected_payments,
        COUNT(*) FILTER (WHERE payment_status = 'FAILED')::int AS failed_payments,
        COUNT(*) FILTER (WHERE payment_status = 'EXPIRED')::int AS expired_payments,
        COUNT(*) FILTER (WHERE payment_status = 'REFUNDED')::int AS refunded_payments,
        COUNT(*) FILTER (WHERE entry_pass_status = 'ACTIVE')::int AS active_entry_passes,
        COUNT(*) FILTER (WHERE ticket_id IS NOT NULL)::int AS tickets_generated,
        COUNT(*) FILTER (WHERE ticket_status = 'UNUSED')::int AS tickets_unused,
        COUNT(*) FILTER (WHERE ticket_status = 'USED')::int AS tickets_used,
        COUNT(*) FILTER (WHERE check_in_status = 'CHECKED_IN')::int AS total_checked_in,
        COUNT(*) FILTER (WHERE check_in_status = 'NOT_CHECKED_IN')::int AS not_checked_in,
        COUNT(*) FILTER (WHERE category = 'FRESHER')::int AS total_freshers,
        COUNT(*) FILTER (WHERE category = 'SENIOR')::int AS total_seniors
      FROM attendees
      WHERE registration_status = 'REGISTERED'
    `);
    return result.rows[0] as DashboardStats;
  }

  const attendees = readLocalStore().attendees.filter((a) => a.registration_status === 'REGISTERED');
  const count = (fn: (a: Attendee) => boolean) => attendees.filter(fn).length;
  return {
    total_registered: attendees.length,
    pending_payments: count((a) => a.payment_status === 'PENDING'),
    submitted_payments: count((a) => a.payment_status === 'PAYMENT_SUBMITTED'),
    processing_payments: count((a) => a.payment_status === 'PROCESSING'),
    successful_payments: count((a) => a.payment_status === 'PAID' || a.payment_status === 'VERIFIED'),
    rejected_payments: count((a) => a.payment_status === 'REJECTED'),
    failed_payments: count((a) => a.payment_status === 'FAILED'),
    expired_payments: count((a) => a.payment_status === 'EXPIRED'),
    refunded_payments: count((a) => a.payment_status === 'REFUNDED'),
    active_entry_passes: count((a) => a.entry_pass_status === 'ACTIVE'),
    tickets_generated: count((a) => !!a.ticket_id),
    tickets_unused: count((a) => a.ticket_status === 'UNUSED'),
    tickets_used: count((a) => a.ticket_status === 'USED'),
    total_checked_in: count((a) => a.check_in_status === 'CHECKED_IN'),
    not_checked_in: count((a) => a.check_in_status === 'NOT_CHECKED_IN'),
    total_freshers: count((a) => a.category === 'FRESHER'),
    total_seniors: count((a) => a.category === 'SENIOR'),
  };
}

export async function listAttendees(params: {
  search?: string;
  category?: string;
  paymentStatus?: string;
  checkInStatus?: string;
  limit?: number;
  offset?: number;
}): Promise<{ attendees: Attendee[]; total: number }> {
  await ensureReady();
  const limit = Math.min(500, Math.max(1, Number(params.limit || 100)));
  const offset = Math.max(0, Number(params.offset || 0));

  if (databaseMode === 'postgres') {
    const conditions: string[] = [`registration_status = 'REGISTERED'`];
    const values: any[] = [];
    const add = (value: any) => {
      values.push(value);
      return `$${values.length}`;
    };

    if (params.search?.trim()) {
      const p = add(`%${params.search.trim()}%`);
      conditions.push(`(
        registration_id ILIKE ${p} OR ticket_id ILIKE ${p} OR full_name ILIKE ${p} OR
        phone ILIKE ${p} OR email ILIKE ${p} OR COALESCE(student_roll_id, '') ILIKE ${p} OR COALESCE(payment_utr, '') ILIKE ${p}
      )`);
    }
    if (params.category && params.category !== 'ALL') conditions.push(`category = ${add(params.category)}`);
    if (params.paymentStatus && params.paymentStatus !== 'ALL') conditions.push(`payment_status = ${add(params.paymentStatus)}`);
    if (params.checkInStatus && params.checkInStatus !== 'ALL') conditions.push(`check_in_status = ${add(params.checkInStatus)}`);

    const where = conditions.join(' AND ');
    const countRes = await getPool().query(`SELECT COUNT(*)::int AS total FROM attendees WHERE ${where}`, values);
    const limitP = add(limit);
    const offsetP = add(offset);
    const rows = await getPool().query(
      `SELECT * FROM attendees WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${limitP} OFFSET ${offsetP}`,
      values
    );
    return { attendees: rows.rows.map(attendeeFromRow), total: Number(countRes.rows[0]?.total || 0) };
  }

  let attendees = readLocalStore().attendees.filter((a) => a.registration_status === 'REGISTERED');
  if (params.search?.trim()) {
    const q = params.search.trim().toLowerCase();
    attendees = attendees.filter((a) =>
      [a.registration_id, a.ticket_id, a.full_name, a.phone, a.email, a.student_roll_id, a.payment_utr]
        .some((v) => String(v || '').toLowerCase().includes(q))
    );
  }
  if (params.category && params.category !== 'ALL') attendees = attendees.filter((a) => a.category === params.category);
  if (params.paymentStatus && params.paymentStatus !== 'ALL') attendees = attendees.filter((a) => a.payment_status === params.paymentStatus);
  if (params.checkInStatus && params.checkInStatus !== 'ALL') attendees = attendees.filter((a) => a.check_in_status === params.checkInStatus);
  attendees.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const total = attendees.length;
  return { attendees: attendees.slice(offset, offset + limit), total };
}
