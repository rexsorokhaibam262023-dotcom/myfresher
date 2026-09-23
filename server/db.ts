import mysql from 'mysql2/promise';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  Attendee,
  AttendeeCategory,
  PaymentStatus,
  EntryPassStatus,
  DashboardStats,
  CreateRegistrationDTO,
  CreateRegistrationResult,
  VerifyQrResult,
  AdminUser,
  PaymentTransaction,
} from './types.js';
import { hashPassword, verifyAttendeeSessionToken } from './auth.js';
import { EventSettings, getCachedEventSettings, setCachedEventSettings, getDefaultEventSettings } from './eventSettings.js';

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_NAME = process.env.DB_NAME || 'msap_freshers_2026';
const DB_USER = process.env.DB_USER || 'msap_user';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const REQUIRE_MYSQL = process.env.REQUIRE_MYSQL === 'true' || IS_PRODUCTION;

let mysqlPool: mysql.Pool | null = null;
let useLocalFallback = false;

// Local fallback store structure
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
  event_settings?: EventSettings;
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

const LOCAL_STORE_PATH = path.resolve(process.cwd(), 'database', 'local_store.json');

// Format registration ID with REG- prefix and zero padding (e.g. REG-0001)
export function formatRegistrationId(counterNumber: number): string {
  return `REG-${String(counterNumber).padStart(4, '0')}`;
}

// Format ticket ID with FM26- prefix and zero padding
export function formatTicketId(counterNumber: number): string {
  return `FM26-${String(counterNumber).padStart(3, '0')}`;
}

function loadLocalStore(): LocalStore {
  try {
    if (fs.existsSync(LOCAL_STORE_PATH)) {
      const data = fs.readFileSync(LOCAL_STORE_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      if (!parsed.payment_transactions) parsed.payment_transactions = [];
      if (!parsed.audit_logs) parsed.audit_logs = [];
      if (!parsed.event_settings) parsed.event_settings = getDefaultEventSettings();
      
      // Auto-migrate attendees to ensure all required fields are present
      if (Array.isArray(parsed.attendees)) {
        parsed.attendees = parsed.attendees.map((a: any) => ({
          ...a,
          registration_id: a.registration_id || formatRegistrationId(a.id),
          ticket_status: a.ticket_status || (a.ticket_id ? (a.check_in_status === 'CHECKED_IN' ? 'USED' : 'UNUSED') : 'NOT_GENERATED'),
          course_class: a.course_class || null,
          academic_year: a.academic_year || null,
          payment_submitted_at: a.payment_submitted_at || null,
          rejection_reason: a.rejection_reason || null,
          checked_in_by: a.checked_in_by || null,
        }));
      }

      return parsed;
    }
  } catch (err) {
    console.error('Error reading local_store.json, creating new one:', err);
  }

  const initialStore: LocalStore = {
    ticket_counter: 1,
    admins: [],
    attendees: [
      {
        id: 1,
        registration_id: 'REG-0001',
        ticket_id: 'FM26-001',
        full_name: 'Aarav Sharma',
        phone: '+91 98765 43210',
        email: 'aarav.fresh26@msap.edu.in',
        college: 'B.Arch - Architecture',
        course_class: 'Architecture',
        academic_year: '1st Year',
        category: 'FRESHER',
        payment_status: 'PAID',
        entry_pass_status: 'ACTIVE',
        ticket_status: 'UNUSED',
        registration_status: 'REGISTERED',
        qr_token: 'msap_qr_token_7f9c8d1e2a3b4c5d6e7f8a9b0c1d2e3f',
        access_token: 'acc_token_aarav_sharma_001',
        check_in_status: 'NOT_CHECKED_IN',
        google_response_id: 'GSHEET_INITIAL_SEED_001',
        student_roll_id: '260901248',
        payment_utr: 'UTR-99201948218X',
        payment_submitted_at: '2026-09-20T09:45:00Z',
        payment_confirmed_at: '2026-09-20T10:00:00Z',
        payment_confirmed_by: 'admin@msap.org',
        rejection_reason: null,
        check_in_time: null,
        checked_in_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    payment_transactions: [
      {
        id: 1,
        registration_id: 1,
        gateway_provider: 'razorpay',
        gateway_order_id: 'order_razorpay_1_initial',
        gateway_payment_id: 'pay_razorpay_1_initial',
        gateway_signature: 'sig_verified_initial',
        amount: 350.0,
        currency: 'INR',
        payment_method: 'upi',
        status: 'PAID',
        paid_at: '2026-09-20T10:00:00Z',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    checkins: [],
    event_settings: getDefaultEventSettings(),
    audit_logs: [],
  };

  saveLocalStore(initialStore);
  return initialStore;
}

function saveLocalStore(store: LocalStore) {
  try {
    const dir = path.dirname(LOCAL_STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving local_store.json:', err);
  }
}

export async function initDatabase(): Promise<void> {
  console.log(`[DATABASE] Checking MySQL connection at ${DB_HOST}:${DB_PORT}/${DB_NAME}...`);
  try {
    const connection = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      connectTimeout: 2000,
    });

    // Create database if not exists
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await connection.end();

    // Create pooled connection to DB
    mysqlPool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: Math.max(5, Math.min(50, parseInt(process.env.DB_CONNECTION_LIMIT || '30', 10))),
      queueLimit: 0,
      enableKeepAlive: true,
    });

    // Execute schema initialization
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS \`admins\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`email\` VARCHAR(255) NOT NULL UNIQUE,
        \`password_hash\` VARCHAR(255) NOT NULL,
        \`role\` VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_admins_email\` (\`email\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS \`ticket_counter\` (
        \`id\` INT PRIMARY KEY,
        \`current_number\` INT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await mysqlPool.query(`
      INSERT INTO \`ticket_counter\` (\`id\`, \`current_number\`)
      VALUES (1, 0)
      ON DUPLICATE KEY UPDATE \`id\` = \`id\`;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS \`event_settings\` (
        \`id\` INT PRIMARY KEY,
        \`event_time\` VARCHAR(100) NOT NULL,
        \`venue\` VARCHAR(500) NOT NULL,
        \`registration_price\` DECIMAL(10, 2) NOT NULL,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    const defaultEventSettings = getDefaultEventSettings();
    await mysqlPool.query(
      `INSERT INTO \`event_settings\` (\`id\`, \`event_time\`, \`venue\`, \`registration_price\`)
       VALUES (1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`id\` = \`id\``,
      [defaultEventSettings.time, defaultEventSettings.venue, defaultEventSettings.registrationPrice]
    );

    const [eventSettingsRows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT event_time, venue, registration_price, updated_at FROM event_settings WHERE id = 1 LIMIT 1'
    );
    if (eventSettingsRows.length > 0) {
      setCachedEventSettings({
        time: String(eventSettingsRows[0].event_time),
        venue: String(eventSettingsRows[0].venue),
        registrationPrice: Number(eventSettingsRows[0].registration_price),
        updatedAt: new Date(eventSettingsRows[0].updated_at).toISOString(),
      });
    }

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS \`attendees\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`ticket_id\` VARCHAR(50) NULL UNIQUE,
        \`full_name\` VARCHAR(255) NOT NULL,
        \`phone\` VARCHAR(50) NOT NULL,
        \`email\` VARCHAR(255) NOT NULL,
        \`college\` VARCHAR(255) NOT NULL,
        \`registration_id\` VARCHAR(50) NULL UNIQUE,
        \`course_class\` VARCHAR(255) NULL,
        \`academic_year\` VARCHAR(100) NULL,
        \`category\` ENUM('FRESHER', 'SENIOR') NOT NULL DEFAULT 'FRESHER',
        \`payment_status\` ENUM('PENDING', 'PAYMENT_SUBMITTED', 'PROCESSING', 'PAID', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
        \`entry_pass_status\` ENUM('NOT_CREATED', 'ACTIVE', 'CHECKED_IN', 'REVOKED') NOT NULL DEFAULT 'NOT_CREATED',
        \`ticket_status\` ENUM('NOT_GENERATED', 'UNUSED', 'USED', 'REVOKED') NOT NULL DEFAULT 'NOT_GENERATED',
        \`registration_status\` ENUM('REGISTERED', 'CANCELLED') NOT NULL DEFAULT 'REGISTERED',
        \`qr_token\` VARCHAR(255) NULL UNIQUE,
        \`access_token\` VARCHAR(255) NOT NULL UNIQUE,
        \`check_in_status\` ENUM('NOT_CHECKED_IN', 'CHECKED_IN') NOT NULL DEFAULT 'NOT_CHECKED_IN',
        \`google_response_id\` VARCHAR(255) NULL UNIQUE,
        \`student_roll_id\` VARCHAR(100) NULL,
        \`payment_utr\` VARCHAR(100) NULL,
        \`payment_submitted_at\` DATETIME NULL,
        \`payment_confirmed_at\` DATETIME NULL,
        \`payment_confirmed_by\` VARCHAR(255) NULL,
        \`rejection_reason\` TEXT NULL,
        \`check_in_time\` DATETIME NULL,
        \`checked_in_by\` VARCHAR(255) NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_attendees_registration_id\` (\`registration_id\`),
        INDEX \`idx_attendees_ticket_id\` (\`ticket_id\`),
        INDEX \`idx_attendees_qr_token\` (\`qr_token\`),
        INDEX \`idx_attendees_access_token\` (\`access_token\`),
        INDEX \`idx_attendees_phone\` (\`phone\`),
        INDEX \`idx_attendees_email\` (\`email\`),
        INDEX \`idx_attendees_payment_status\` (\`payment_status\`),
        INDEX \`idx_attendees_entry_pass_status\` (\`entry_pass_status\`),
        INDEX \`idx_attendees_check_in_status\` (\`check_in_status\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS \`payment_transactions\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`registration_id\` INT NOT NULL,
        \`gateway_provider\` VARCHAR(50) NOT NULL DEFAULT 'razorpay',
        \`gateway_order_id\` VARCHAR(100) NOT NULL,
        \`gateway_payment_id\` VARCHAR(100) NULL,
        \`gateway_signature\` VARCHAR(255) NULL,
        \`amount\` DECIMAL(10, 2) NOT NULL DEFAULT 350.00,
        \`currency\` VARCHAR(10) NOT NULL DEFAULT 'INR',
        \`payment_method\` VARCHAR(50) NULL,
        \`status\` ENUM('PENDING', 'PAYMENT_SUBMITTED', 'PROCESSING', 'PAID', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
        \`gateway_event_id\` VARCHAR(100) NULL UNIQUE,
        \`paid_at\` DATETIME NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_tx_reg_id\` (\`registration_id\`),
        INDEX \`idx_tx_order_id\` (\`gateway_order_id\`),
        INDEX \`idx_tx_payment_id\` (\`gateway_payment_id\`),
        INDEX \`idx_tx_status\` (\`status\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    const ensureColumn = async (table: string, column: string, definition: string) => {
      const [rows] = await mysqlPool!.query<mysql.RowDataPacket[]>(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [DB_NAME, table, column]
      );
      if (rows.length === 0) {
        await mysqlPool!.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      }
    };

    await mysqlPool.query(`
      ALTER TABLE \`attendees\`
      MODIFY \`payment_status\` ENUM('PENDING', 'PAYMENT_SUBMITTED', 'PROCESSING', 'PAID', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'REFUNDED') NOT NULL DEFAULT 'PENDING'
    `);
    await mysqlPool.query(`
      ALTER TABLE \`payment_transactions\`
      MODIFY \`status\` ENUM('PENDING', 'PAYMENT_SUBMITTED', 'PROCESSING', 'PAID', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'REFUNDED') NOT NULL DEFAULT 'PENDING'
    `);
    await ensureColumn('attendees', 'registration_id', 'VARCHAR(50) NULL UNIQUE');
    await ensureColumn('attendees', 'course_class', 'VARCHAR(255) NULL');
    await ensureColumn('attendees', 'academic_year', 'VARCHAR(100) NULL');
    await ensureColumn('attendees', 'ticket_status', "ENUM('NOT_GENERATED', 'UNUSED', 'USED', 'REVOKED') NOT NULL DEFAULT 'NOT_GENERATED'");
    await ensureColumn('attendees', 'payment_submitted_at', 'DATETIME NULL');
    await ensureColumn('attendees', 'rejection_reason', 'TEXT NULL');
    await ensureColumn('attendees', 'checked_in_by', 'VARCHAR(255) NULL');

    // Safe UTR Unique Index Migration:
    // 1. Normalize empty string UTRs to NULL and trim whitespace
    await mysqlPool.query("UPDATE `attendees` SET `payment_utr` = NULL WHERE TRIM(`payment_utr`) = ''");
    await mysqlPool.query("UPDATE `attendees` SET `payment_utr` = TRIM(`payment_utr`) WHERE `payment_utr` IS NOT NULL");

    // 2. Check for existing duplicate non-null UTR values
    const [dupUtrs] = await mysqlPool.query<mysql.RowDataPacket[]>(
      "SELECT `payment_utr`, COUNT(*) as cnt FROM `attendees` WHERE `payment_utr` IS NOT NULL GROUP BY `payment_utr` HAVING cnt > 1"
    );
    if (dupUtrs.length > 0) {
      console.warn(`[DATABASE MIGRATION WARNING] Found ${dupUtrs.length} duplicate UTR group(s) in attendees table. Conflict records:`, dupUtrs);
      console.warn('[DATABASE MIGRATION WARNING] Unique index creation deferred until duplicate UTR values are manually reconciled. Existing data preserved.');
    } else {
      // 3. Check if unique index already exists
      const [existingIdx] = await mysqlPool.query<mysql.RowDataPacket[]>(
        "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'attendees' AND INDEX_NAME = 'idx_unique_attendees_payment_utr'",
        [DB_NAME]
      );
      if (existingIdx.length === 0) {
        await mysqlPool.query("CREATE UNIQUE INDEX `idx_unique_attendees_payment_utr` ON `attendees` (`payment_utr`)");
        console.log('[DATABASE] Safely verified and created UNIQUE INDEX `idx_unique_attendees_payment_utr` on attendees.');
      }
    }

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS \`checkins\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`attendee_id\` INT NOT NULL,
        \`ticket_id\` VARCHAR(50) NOT NULL,
        \`checked_in_by\` VARCHAR(255) NOT NULL,
        \`check_in_time\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_checkins_ticket_id\` (\`ticket_id\`),
        INDEX \`idx_checkins_attendee_id\` (\`attendee_id\`),
        CONSTRAINT \`fk_checkins_attendee\`
          FOREIGN KEY (\`attendee_id\`) REFERENCES \`attendees\` (\`id\`)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS \`audit_logs\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`admin_id\` INT NULL,
        \`attendee_id\` INT NULL,
        \`action\` VARCHAR(100) NOT NULL,
        \`details\` TEXT NULL,
        \`ip_address\` VARCHAR(50) NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_audit_action\` (\`action\`),
        INDEX \`idx_audit_attendee\` (\`attendee_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Ensure default admin exists
    const defaultEmail = process.env.ADMIN_DEFAULT_EMAIL || 'admin@msap.org';
    const [existingAdmins] = await mysqlPool.query<mysql.RowDataPacket[]>('SELECT id FROM admins WHERE email = ?', [defaultEmail]);
    if (existingAdmins.length === 0) {
      if (IS_PRODUCTION && (!process.env.ADMIN_DEFAULT_PASSWORD || process.env.ADMIN_DEFAULT_PASSWORD.includes('ChangeMe') || process.env.ADMIN_DEFAULT_PASSWORD.length < 8)) {
        throw new Error('[FATAL SECURITY ERROR] ADMIN_DEFAULT_PASSWORD must be configured in environment variables with at least 8 characters for production.');
      }
      const defaultPassword = process.env.ADMIN_DEFAULT_PASSWORD || 'dev_admin_password_freshers_2026';
      const hash = await hashPassword(defaultPassword);
      await mysqlPool.query('INSERT INTO admins (email, password_hash, role) VALUES (?, ?, ?)', [defaultEmail, hash, 'ADMIN']);
      console.log(`[DATABASE] Default admin created: ${defaultEmail}`);
    }

    console.log(`[DATABASE] Connected to live MySQL database '${DB_NAME}' successfully!`);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (REQUIRE_MYSQL) {
      console.error(`[DATABASE CRITICAL ERROR] Failed to connect to MySQL database at ${DB_HOST}:${DB_PORT}/${DB_NAME}: ${errorMsg}`);
      console.error('[DATABASE CRITICAL ERROR] In production mode (REQUIRE_MYSQL=true), automatic fallback to local JSON storage is strictly prohibited to prevent data loss or duplicate ticketing.');
      throw new Error(`[FATAL] MySQL connection failure in production: ${errorMsg}. Local JSON fallback is disabled.`);
    }

    console.warn(`[DATABASE DEV WARNING] MySQL connection not established (${errorMsg}). Switching to persistent relational storage mode for local development.`);
    useLocalFallback = true;
    const store = loadLocalStore();
    const localEventSettings = store.event_settings || getDefaultEventSettings();
    store.event_settings = localEventSettings;
    setCachedEventSettings(localEventSettings);

    // Ensure default admin in local store
    const defaultEmail = process.env.ADMIN_DEFAULT_EMAIL || 'admin@msap.org';
    const exists = store.admins.find((a) => a.email.toLowerCase() === defaultEmail.toLowerCase());
    if (!exists) {
      if (IS_PRODUCTION && (!process.env.ADMIN_DEFAULT_PASSWORD || process.env.ADMIN_DEFAULT_PASSWORD.includes('ChangeMe') || process.env.ADMIN_DEFAULT_PASSWORD.length < 8)) {
        throw new Error('[FATAL SECURITY ERROR] ADMIN_DEFAULT_PASSWORD must be configured in environment variables with at least 8 characters for production.');
      }
      const defaultPassword = process.env.ADMIN_DEFAULT_PASSWORD || 'dev_admin_password_freshers_2026';
      const hash = await hashPassword(defaultPassword);
      store.admins.push({
        id: 1,
        email: defaultEmail,
        password_hash: hash,
        role: 'ADMIN',
        created_at: new Date().toISOString(),
      });
      saveLocalStore(store);
      console.log(`[DATABASE] Seeded default admin in local storage: ${defaultEmail}`);
    }
  }
}

export function isUsingMySQL(): boolean {
  return !useLocalFallback && mysqlPool !== null;
}

/**
 * Atomic Ticket ID generator using database transaction on `ticket_counter`
 */
export async function generateNextTicketId(): Promise<string> {
  if (isUsingMySQL() && mysqlPool) {
    const conn = await mysqlPool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT current_number FROM ticket_counter WHERE id = 1 FOR UPDATE'
      );
      let currentNumber = 0;
      if (rows.length > 0) {
        currentNumber = rows[0].current_number;
      } else {
        await conn.query('INSERT INTO ticket_counter (id, current_number) VALUES (1, 0)');
      }

      const nextNumber = currentNumber + 1;
      await conn.query('UPDATE ticket_counter SET current_number = ? WHERE id = 1', [nextNumber]);
      await conn.commit();
      return formatTicketId(nextNumber);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    // Local fallback with synchronous state lock
    const store = loadLocalStore();
    store.ticket_counter = (store.ticket_counter || 0) + 1;
    saveLocalStore(store);
    return formatTicketId(store.ticket_counter);
  }
}

/**
 * Creates a new attendee registration record
 * STRICT ENFORCEMENT: Ticket ID and QR Token remain NULL until payment status is PAID.
 */
/**
 * Creates a new attendee registration record
 * STRICT ENFORCEMENT: Ticket ID and QR Token remain NULL until payment status is PAID.
 * Prevents duplicate registrations by verifying existing records against phone, email, and roll ID.
 */
export async function createAttendee(dto: CreateRegistrationDTO): Promise<CreateRegistrationResult> {
  const accessToken = `acc_${crypto.randomBytes(24).toString('hex')}`;
  const paymentStatus: PaymentStatus = 'PENDING';
  const entryPassStatus: EntryPassStatus = 'NOT_CREATED';
  const category: AttendeeCategory = dto.category === 'SENIOR' ? 'SENIOR' : 'FRESHER';

  const cleanPhoneDigits = dto.phone.replace(/\D/g, '');
  const phoneSuffix = cleanPhoneDigits.length >= 10 ? cleanPhoneDigits.slice(-10) : cleanPhoneDigits;
  const cleanEmail = dto.email.trim().toLowerCase();
  const cleanRoll = dto.rollId ? dto.rollId.trim().toLowerCase() : null;

  if (isUsingMySQL() && mysqlPool) {
    // 1. Check duplicate Google Response ID if provided
    if (dto.googleResponseId) {
      const [existingGoogle] = await mysqlPool.query<mysql.RowDataPacket[]>(
        'SELECT * FROM attendees WHERE google_response_id = ?',
        [dto.googleResponseId]
      );
      if (existingGoogle.length > 0) {
        return { attendee: existingGoogle[0] as Attendee, isDuplicate: true };
      }
    }

    // 2. Strong Identity Duplicate Check:
    // Requires (phone AND email) OR (rollId AND (phone OR email)) to prevent identity collision/enumeration
    const [existingRows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      `SELECT * FROM attendees 
       WHERE (REPLACE(REPLACE(phone, ' ', ''), '+91', '') LIKE ? AND LOWER(email) = ?)
          OR (? IS NOT NULL AND LOWER(student_roll_id) = ? AND (REPLACE(REPLACE(phone, ' ', ''), '+91', '') LIKE ? OR LOWER(email) = ?))
       LIMIT 1`,
      [
        `%${phoneSuffix}`,
        cleanEmail,
        cleanRoll,
        cleanRoll || '__none__',
        `%${phoneSuffix}`,
        cleanEmail,
      ]
    );

    if (existingRows.length > 0) {
      const existing = existingRows[0] as Attendee;
      return { attendee: existing, isDuplicate: true };
    }

    // 3. Partial Collision Protection:
    // If phone alone, email alone, or roll alone matches without verified dual-factor identity,
    // prevent taking over an existing registration or creating duplicate conflicts.
    const [partialRows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      `SELECT id FROM attendees 
       WHERE REPLACE(REPLACE(phone, ' ', ''), '+91', '') LIKE ?
          OR LOWER(email) = ?
          OR (? IS NOT NULL AND LOWER(student_roll_id) = ?)
       LIMIT 1`,
      [`%${phoneSuffix}`, cleanEmail, cleanRoll, cleanRoll || '__none__']
    );

    if (partialRows.length > 0) {
      return {
        isDuplicate: false,
        isPartialDuplicate: true,
        message: 'An existing registration may already exist with this phone number, email, or student roll ID. Please use Retrieve Existing Pass.',
      };
    }

    const [result] = await mysqlPool.query<mysql.ResultSetHeader>(
      `INSERT INTO attendees (
        ticket_id, full_name, phone, email, college, course_class, academic_year, category,
        payment_status, entry_pass_status, ticket_status, registration_status, qr_token, access_token,
        check_in_status, google_response_id, student_roll_id, payment_utr
      ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NOT_GENERATED', 'REGISTERED', NULL, ?, 'NOT_CHECKED_IN', ?, ?, ?)`,
      [
        dto.fullName,
        dto.phone,
        dto.email,
        dto.college,
        dto.courseClass || null,
        dto.academicYear || null,
        category,
        paymentStatus,
        entryPassStatus,
        accessToken,
        dto.googleResponseId || null,
        dto.rollId || null,
        dto.paymentUtr || null,
      ]
    );

    const regId = formatRegistrationId(result.insertId);
    await mysqlPool.query('UPDATE attendees SET registration_id = ? WHERE id = ?', [regId, result.insertId]);

    await mysqlPool.query(
      `INSERT INTO audit_logs (attendee_id, action, details)
       VALUES (?, 'REGISTRATION_CREATED', ?)`,
      [result.insertId, `New registration created: ${regId} for ${dto.fullName} (${category})`]
    );

    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM attendees WHERE id = ?',
      [result.insertId]
    );
    return { attendee: rows[0] as Attendee, isDuplicate: false };
  } else {
    const store = loadLocalStore();
    if (dto.googleResponseId) {
      const existing = store.attendees.find((a) => a.google_response_id === dto.googleResponseId);
      if (existing) return { attendee: existing, isDuplicate: true };
    }

    // LocalStore Strong Identity Duplicate Check
    const existing = store.attendees.find((a) => {
      const aPhoneDigits = a.phone.replace(/\D/g, '');
      const phoneMatch = aPhoneDigits.endsWith(phoneSuffix) || phoneSuffix.endsWith(aPhoneDigits.slice(-10));
      const emailMatch = a.email.trim().toLowerCase() === cleanEmail;
      const aRoll = a.student_roll_id ? a.student_roll_id.trim().toLowerCase() : '';
      const rollMatch = cleanRoll && aRoll && aRoll === cleanRoll;

      if (phoneMatch && emailMatch) return true;
      if (rollMatch && (phoneMatch || emailMatch)) return true;
      return false;
    });

    if (existing) {
      return { attendee: existing, isDuplicate: true };
    }

    // LocalStore Partial Collision Protection
    const partialMatch = store.attendees.find((a) => {
      const aPhoneDigits = a.phone.replace(/\D/g, '');
      const phoneMatch = aPhoneDigits.endsWith(phoneSuffix) || phoneSuffix.endsWith(aPhoneDigits.slice(-10));
      const emailMatch = a.email.trim().toLowerCase() === cleanEmail;
      const aRoll = a.student_roll_id ? a.student_roll_id.trim().toLowerCase() : '';
      const rollMatch = cleanRoll && aRoll && aRoll === cleanRoll;
      return phoneMatch || emailMatch || rollMatch;
    });

    if (partialMatch) {
      return {
        isDuplicate: false,
        isPartialDuplicate: true,
        message: 'An existing registration may already exist with this phone number, email, or student roll ID. Please use Retrieve Existing Pass.',
      };
    }

    const newId = store.attendees.length > 0 ? Math.max(...store.attendees.map((a) => a.id)) + 1 : 1;
    const regId = formatRegistrationId(newId);
    const now = new Date().toISOString();
    const newAttendee: Attendee = {
      id: newId,
      registration_id: regId,
      ticket_id: null, // Strictly NULL until verified PAID
      full_name: dto.fullName,
      phone: dto.phone,
      email: dto.email,
      college: dto.college,
      course_class: dto.courseClass || null,
      academic_year: dto.academicYear || null,
      category,
      payment_status: paymentStatus,
      entry_pass_status: entryPassStatus,
      ticket_status: 'NOT_GENERATED',
      registration_status: 'REGISTERED',
      qr_token: null, // Strictly NULL until verified PAID
      access_token: accessToken,
      check_in_status: 'NOT_CHECKED_IN',
      google_response_id: dto.googleResponseId || null,
      student_roll_id: dto.rollId || null,
      payment_utr: dto.paymentUtr || null,
      payment_submitted_at: null,
      payment_confirmed_at: null,
      payment_confirmed_by: null,
      rejection_reason: null,
      check_in_time: null,
      checked_in_by: null,
      created_at: now,
      updated_at: now,
    };

    store.attendees.unshift(newAttendee);
    store.audit_logs.push({
      id: store.audit_logs.length + 1,
      attendee_id: newId,
      action: 'REGISTRATION_CREATED',
      details: `New registration created: ${regId} for ${dto.fullName} (${category})`,
      created_at: now,
    });
    saveLocalStore(store);
    return { attendee: newAttendee, isDuplicate: false };
  }
}

/**
 * Creates an order record in payment_transactions table
 */
export async function createPaymentTransaction(params: {
  registrationId: number;
  gatewayProvider: string;
  gatewayOrderId: string;
  amount: number;
  currency?: string;
}): Promise<PaymentTransaction> {
  const { registrationId, gatewayProvider, gatewayOrderId, amount, currency = 'INR' } = params;

  if (isUsingMySQL() && mysqlPool) {
    const [result] = await mysqlPool.query<mysql.ResultSetHeader>(
      `INSERT INTO payment_transactions (
        registration_id, gateway_provider, gateway_order_id, amount, currency, status
      ) VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      [registrationId, gatewayProvider, gatewayOrderId, amount, currency]
    );

    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM payment_transactions WHERE id = ?',
      [result.insertId]
    );
    return rows[0] as PaymentTransaction;
  } else {
    const store = loadLocalStore();
    const newId = store.payment_transactions.length > 0
      ? Math.max(...store.payment_transactions.map((t) => t.id)) + 1
      : 1;
    const now = new Date().toISOString();
    const tx: PaymentTransaction = {
      id: newId,
      registration_id: registrationId,
      gateway_provider: gatewayProvider,
      gateway_order_id: gatewayOrderId,
      amount,
      currency,
      status: 'PENDING',
      created_at: now,
      updated_at: now,
    };
    store.payment_transactions.push(tx);
    saveLocalStore(store);
    return tx;
  }
}

/**
 * Atomically marks payment as PAID, increments ticket_counter, and creates Entry Pass + QR code
 */
export async function markPaymentSuccessfulAndGeneratePass(params: {
  registrationId: number;
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  gatewaySignature?: string;
  paymentMethod?: string;
  confirmedBy?: string;
  eventId?: string;
  isManualOverride?: boolean;
  overrideReason?: string;
  adminId?: number;
}): Promise<{ attendee: Attendee; isNewPass: boolean }> {
  const {
    registrationId,
    gatewayOrderId,
    gatewayPaymentId,
    gatewaySignature,
    paymentMethod = 'upi',
    confirmedBy = 'SYSTEM_GATEWAY_WEBHOOK',
    eventId,
    isManualOverride = false,
    overrideReason,
    adminId,
  } = params;

  if (isUsingMySQL() && mysqlPool) {
    const conn = await mysqlPool.getConnection();
    try {
      await conn.beginTransaction();

      // Check idempotency if webhook eventId provided
      if (eventId) {
        const [existingEvents] = await conn.query<mysql.RowDataPacket[]>(
          'SELECT id FROM payment_transactions WHERE gateway_event_id = ? AND status = "PAID"',
          [eventId]
        );
        if (existingEvents.length > 0) {
          const [att] = await conn.query<mysql.RowDataPacket[]>(
            'SELECT * FROM attendees WHERE id = ?',
            [registrationId]
          );
          await conn.rollback();
          return { attendee: att[0] as Attendee, isNewPass: false };
        }
      }

      // Lock attendee row FOR UPDATE
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT * FROM attendees WHERE id = ? FOR UPDATE',
        [registrationId]
      );

      if (rows.length === 0) {
        await conn.rollback();
        throw new Error(`Attendee #${registrationId} not found.`);
      }

      const attendee = rows[0] as Attendee;

      // If already PAID and already has ticket_id, keep existing pass (idempotent)
      if (attendee.payment_status === 'PAID' && attendee.ticket_id && attendee.qr_token) {
        await conn.commit();
        return { attendee, isNewPass: false };
      }

      // Generate atomic ticket ID
      const [counterRows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT current_number FROM ticket_counter WHERE id = 1 FOR UPDATE'
      );
      let currentNumber = 0;
      if (counterRows.length > 0) {
        currentNumber = counterRows[0].current_number;
      } else {
        await conn.query('INSERT INTO ticket_counter (id, current_number) VALUES (1, 0)');
      }

      const nextNumber = currentNumber + 1;
      await conn.query('UPDATE ticket_counter SET current_number = ? WHERE id = 1', [nextNumber]);
      const newTicketId = formatTicketId(nextNumber);
      const newQrToken = `msap_token_${crypto.randomBytes(32).toString('hex')}`;

      const confirmedByFormatted = isManualOverride
        ? `MANUAL_OVERRIDE_BY_${confirmedBy}${overrideReason ? ` (Reason: ${overrideReason})` : ''}`
        : confirmedBy;

      // Update attendee record
      await conn.query(
        `UPDATE attendees 
         SET ticket_id = ?,
             qr_token = ?,
             payment_status = 'PAID',
             entry_pass_status = 'ACTIVE',
             ticket_status = 'UNUSED',
             payment_confirmed_at = NOW(),
             payment_confirmed_by = ?
         WHERE id = ?`,
        [newTicketId, newQrToken, confirmedByFormatted, registrationId]
      );

      // Update or create payment_transaction record
      if (gatewayOrderId) {
        await conn.query(
          `UPDATE payment_transactions
           SET status = 'PAID',
               gateway_payment_id = ?,
               gateway_signature = ?,
               payment_method = ?,
               gateway_event_id = ?,
               paid_at = NOW()
           WHERE gateway_order_id = ?`,
          [gatewayPaymentId || null, gatewaySignature || null, paymentMethod, eventId || null, gatewayOrderId]
        );
      } else {
        await conn.query(
          `INSERT INTO payment_transactions (
            registration_id, gateway_provider, gateway_order_id, gateway_payment_id,
            gateway_signature, amount, currency, payment_method, status, gateway_event_id, paid_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, 'PAID', ?, NOW())`,
          [
            registrationId,
            isManualOverride ? 'admin_manual_override' : 'payment_gateway',
            `tx_${Date.now()}_${registrationId}`,
            gatewayPaymentId || `pay_manual_${Date.now()}`,
            gatewaySignature || null,
            getCachedEventSettings().registrationPrice,
            paymentMethod,
            eventId || null,
          ]
        );
      }

      // Distinguish audit log: PAYMENT_CONFIRMED_BY_GATEWAY vs PAYMENT_MANUALLY_CONFIRMED
      const auditAction = isManualOverride ? 'PAYMENT_MANUALLY_CONFIRMED' : 'PAYMENT_CONFIRMED_BY_GATEWAY';
      const auditDetails = isManualOverride
        ? `Emergency manual payment override confirmed by Admin ID ${adminId || 'N/A'} (${confirmedBy}). Reason: ${overrideReason || 'Administrative exception'}. Ticket ${newTicketId} issued.`
        : `Payment verified via gateway. Order: ${gatewayOrderId || 'N/A'}, Payment: ${gatewayPaymentId || 'N/A'}. Ticket ${newTicketId} issued.`;

      await conn.query(
        `INSERT INTO audit_logs (admin_id, attendee_id, action, details)
         VALUES (?, ?, ?, ?)`,
        [adminId || null, registrationId, auditAction, auditDetails]
      );

      await conn.commit();

      const [updatedRows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT * FROM attendees WHERE id = ?',
        [registrationId]
      );
      return { attendee: updatedRows[0] as Attendee, isNewPass: true };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    // Local storage fallback
    const store = loadLocalStore();
    const attendee = store.attendees.find((a) => a.id === registrationId);
    if (!attendee) {
      throw new Error(`Attendee #${registrationId} not found.`);
    }

    if (attendee.payment_status === 'PAID' && attendee.ticket_id && attendee.qr_token) {
      return { attendee, isNewPass: false };
    }

    store.ticket_counter = (store.ticket_counter || 0) + 1;
    const newTicketId = formatTicketId(store.ticket_counter);
    const newQrToken = `msap_token_${crypto.randomBytes(32).toString('hex')}`;
    const now = new Date().toISOString();

    const confirmedByFormatted = isManualOverride
      ? `MANUAL_OVERRIDE_BY_${confirmedBy}${overrideReason ? ` (Reason: ${overrideReason})` : ''}`
      : confirmedBy;

    attendee.ticket_id = newTicketId;
    attendee.qr_token = newQrToken;
    attendee.payment_status = 'PAID';
    attendee.entry_pass_status = 'ACTIVE';
    attendee.ticket_status = 'UNUSED';
    attendee.payment_confirmed_at = now;
    attendee.payment_confirmed_by = confirmedByFormatted;
    attendee.updated_at = now;

    // Record transaction
    const tx = store.payment_transactions.find(
      (t) => gatewayOrderId && t.gateway_order_id === gatewayOrderId
    );
    if (tx) {
      tx.status = 'PAID';
      tx.gateway_payment_id = gatewayPaymentId || `pay_${Date.now()}`;
      tx.gateway_signature = gatewaySignature;
      tx.payment_method = paymentMethod;
      tx.gateway_event_id = eventId;
      tx.paid_at = now;
      tx.updated_at = now;
    } else {
      store.payment_transactions.push({
        id: store.payment_transactions.length + 1,
        registration_id: registrationId,
        gateway_provider: isManualOverride ? 'admin_manual_override' : 'payment_gateway',
        gateway_order_id: gatewayOrderId || `manual_${Date.now()}`,
        gateway_payment_id: gatewayPaymentId || `pay_manual_${Date.now()}`,
        gateway_signature: gatewaySignature,
        amount: 350.0,
        currency: 'INR',
        payment_method: paymentMethod,
        status: 'PAID',
        gateway_event_id: eventId,
        paid_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    const auditAction = isManualOverride ? 'PAYMENT_MANUALLY_CONFIRMED' : 'PAYMENT_CONFIRMED_BY_GATEWAY';
    const auditDetails = isManualOverride
      ? `Emergency manual payment override confirmed by Admin ID ${adminId || 'N/A'} (${confirmedBy}). Reason: ${overrideReason || 'Administrative exception'}. Ticket ${newTicketId} issued.`
      : `Payment verified via gateway. Order: ${gatewayOrderId || 'N/A'}, Payment: ${gatewayPaymentId || 'N/A'}. Ticket ${newTicketId} issued.`;

    store.audit_logs.push({
      id: store.audit_logs.length + 1,
      admin_id: adminId || null,
      attendee_id: registrationId,
      action: auditAction,
      details: auditDetails,
      created_at: now,
    });

    saveLocalStore(store);
    return { attendee, isNewPass: true };
  }
}

/**
 * Marks payment as FAILED or EXPIRED
 */
export async function markPaymentFailed(params: {
  registrationId: number;
  gatewayOrderId?: string;
  reason?: string;
  status?: 'FAILED' | 'EXPIRED';
}): Promise<void> {
  const { registrationId, gatewayOrderId, reason = 'Payment failed or declined', status = 'FAILED' } = params;

  if (isUsingMySQL() && mysqlPool) {
    await mysqlPool.query(
      `UPDATE attendees 
       SET payment_status = ?, entry_pass_status = 'NOT_CREATED'
       WHERE id = ? AND payment_status != 'PAID'`,
      [status, registrationId]
    );

    if (gatewayOrderId) {
      await mysqlPool.query(
        'UPDATE payment_transactions SET status = ? WHERE gateway_order_id = ?',
        [status, gatewayOrderId]
      );
    }
  } else {
    const store = loadLocalStore();
    const attendee = store.attendees.find((a) => a.id === registrationId);
    if (attendee && attendee.payment_status !== 'PAID') {
      attendee.payment_status = status;
      attendee.entry_pass_status = 'NOT_CREATED';
      attendee.updated_at = new Date().toISOString();
    }
    if (gatewayOrderId) {
      const tx = store.payment_transactions.find((t) => t.gateway_order_id === gatewayOrderId);
      if (tx) {
        tx.status = status;
        tx.updated_at = new Date().toISOString();
      }
    }
    saveLocalStore(store);
  }
}

/**
 * Retrieves public attendee ticket by secure access token
 */
export async function getAttendeeByAccessToken(token: string): Promise<Attendee | null> {
  if (!token) return null;

  // First check if token is a valid signed attendee session token
  const session = verifyAttendeeSessionToken(token);
  if (session && session.attendeeId) {
    const attendee = await getAttendeeById(session.attendeeId);
    if (attendee) return attendee;
  }

  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM attendees WHERE access_token = ? OR qr_token = ?',
      [token, token]
    );
    return rows.length > 0 ? (rows[0] as Attendee) : null;
  } else {
    const store = loadLocalStore();
    return store.attendees.find((a) => a.access_token === token || (a.qr_token && a.qr_token === token)) || null;
  }
}

/**
 * Finds attendee by ticket ID (e.g. FM26-001)
 */
export async function getAttendeeByTicketId(ticketId: string): Promise<Attendee | null> {
  const cleanId = ticketId.trim().toUpperCase();
  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM attendees WHERE UPPER(ticket_id) = ?',
      [cleanId]
    );
    return rows.length > 0 ? (rows[0] as Attendee) : null;
  } else {
    const store = loadLocalStore();
    return store.attendees.find((a) => a.ticket_id && a.ticket_id.toUpperCase() === cleanId) || null;
  }
}

/**
 * Searches attendees for pass lookup (phone, email, ticket_id, or roll_id)
 */
export async function lookupAttendee(query: string): Promise<Attendee | null> {
  const q = query.trim();
  if (!q) return null;

  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      `SELECT * FROM attendees 
       WHERE ticket_id = ? OR phone = ? OR email = ? OR student_roll_id = ?
       LIMIT 1`,
      [q, q, q, q]
    );
    return rows.length > 0 ? (rows[0] as Attendee) : null;
  } else {
    const store = loadLocalStore();
    const cleanQ = q.toLowerCase();
    return (
      store.attendees.find(
        (a) =>
          (a.ticket_id && a.ticket_id.toLowerCase() === cleanQ) ||
          a.phone.replace(/\s+/g, '').includes(cleanQ.replace(/\s+/g, '')) ||
          a.email.toLowerCase() === cleanQ ||
          (a.student_roll_id && a.student_roll_id.toLowerCase() === cleanQ)
      ) || null
    );
  }
}

/**
 * Requirement 13: Secure Two-Factor Pass Lookup
 * Requires BOTH Phone AND (Email or Student Roll ID) to prevent ticket harvesting
 */
export async function lookupAttendeeSecure(phone: string, emailOrRoll: string): Promise<Attendee | null> {
  const cleanPhone = phone.trim().replace(/\D/g, '');
  const cleanKey = emailOrRoll.trim().toLowerCase();
  if (!cleanPhone || !cleanKey) return null;

  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      `SELECT * FROM attendees 
       WHERE (REPLACE(REPLACE(phone, ' ', ''), '+91', '') LIKE ?)
         AND (LOWER(email) = ? OR LOWER(student_roll_id) = ?)
       LIMIT 1`,
      [`%${cleanPhone.slice(-10)}%`, cleanKey, cleanKey]
    );
    return rows.length > 0 ? (rows[0] as Attendee) : null;
  } else {
    const store = loadLocalStore();
    return (
      store.attendees.find((a) => {
        const p = a.phone.replace(/\D/g, '');
        const matchesPhone = p.endsWith(cleanPhone.slice(-10)) || cleanPhone.endsWith(p.slice(-10));
        const matchesEmailOrRoll =
          a.email.toLowerCase() === cleanKey ||
          (a.student_roll_id && a.student_roll_id.toLowerCase() === cleanKey);
        return matchesPhone && matchesEmailOrRoll;
      }) || null
    );
  }
}

export async function getLatestPaymentTransactionByRegistrationId(registrationId: number): Promise<PaymentTransaction | null> {
  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      `SELECT * FROM payment_transactions
       WHERE registration_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [registrationId]
    );
    return rows.length > 0 ? (rows[0] as PaymentTransaction) : null;
  }

  const store = loadLocalStore();
  return store.payment_transactions
    .filter((t) => t.registration_id === registrationId)
    .sort((a, b) => b.id - a.id)[0] || null;
}

/**
 * Requirement 7: Get Payment Transaction by Gateway Order ID to verify ownership
 */
export async function getPaymentTransactionByOrderId(orderId: string): Promise<PaymentTransaction | null> {
  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM payment_transactions WHERE gateway_order_id = ?',
      [orderId]
    );
    return rows.length > 0 ? (rows[0] as PaymentTransaction) : null;
  } else {
    const store = loadLocalStore();
    return store.payment_transactions.find((t) => t.gateway_order_id === orderId) || null;
  }
}

/**
 * Find admin user by email for authentication
 */
export async function findAdminByEmail(email: string): Promise<AdminUser | null> {
  const cleanEmail = email.trim().toLowerCase();
  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM admins WHERE LOWER(email) = ?',
      [cleanEmail]
    );
    return rows.length > 0 ? (rows[0] as AdminUser) : null;
  }

  const store = loadLocalStore();
  return store.admins.find((a) => a.email.toLowerCase() === cleanEmail) || null;
}

/**
 * Submit Payment Reference / UTR by Student
 * Transitions state to PAYMENT_SUBMITTED. Does NOT issue ticket.
 */
export async function submitPaymentUtr(params: {
  identifier: string | number;
  paymentUtr: string;
}): Promise<Attendee> {
  const { identifier, paymentUtr } = params;
  const cleanUtr = String(paymentUtr || '').trim().replace(/\s+/g, '');
  if (!/^\d{12}$/.test(cleanUtr)) {
    throw new Error('Please enter a valid 12-digit UPI transaction reference (UTR).');
  }

  const now = new Date().toISOString();
  const maskedUtr = `${cleanUtr.slice(0, 4)}••••${cleanUtr.slice(8)}`;

  // Securely resolve attendee strictly via signed session token, permanent access token, or internal numeric id
  let attendee: Attendee | null = null;
  const strId = String(identifier).trim();
  const session = verifyAttendeeSessionToken(strId);
  if (session && session.attendeeId) {
    attendee = await getAttendeeById(session.attendeeId);
  } else if (typeof identifier === 'number' || /^\d+$/.test(strId)) {
    attendee = await getAttendeeById(Number(identifier));
  } else {
    attendee = await getAttendeeByAccessToken(strId);
  }

  if (!attendee) {
    throw new Error('Attendee registration record not found or session expired.');
  }

  if (attendee.payment_status === 'PAID') {
    return attendee;
  }

  if (isUsingMySQL() && mysqlPool) {
    // Check if this UTR is already assigned to another attendee
    const [dupRows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT id, registration_id FROM attendees WHERE payment_utr = ? AND id != ? LIMIT 1',
      [cleanUtr, attendee.id]
    );
    if (dupRows.length > 0) {
      const err: any = new Error('This transaction reference has already been submitted.');
      err.statusCode = 409;
      throw err;
    }

    await mysqlPool.query(
      `UPDATE attendees
       SET payment_utr = ?,
           payment_status = 'PAYMENT_SUBMITTED',
           payment_submitted_at = NOW()
       WHERE id = ?`,
      [cleanUtr, attendee.id]
    );

    await mysqlPool.query(
      `INSERT INTO audit_logs (attendee_id, action, details)
       VALUES (?, 'PAYMENT_UTR_SUBMITTED', ?)`,
      [attendee.id, `Student submitted 12-digit payment UTR: ${maskedUtr}. Waiting for admin verification.`]
    );

    const [updatedRows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM attendees WHERE id = ?',
      [attendee.id]
    );
    return updatedRows[0] as Attendee;
  } else {
    const store = loadLocalStore();
    const storeAttendee = store.attendees.find((a) => a.id === attendee!.id);
    if (!storeAttendee) {
      throw new Error('Attendee registration record not found.');
    }

    if (storeAttendee.payment_status === 'PAID') {
      return storeAttendee;
    }

    // Check if this UTR is already assigned to another attendee
    const duplicate = store.attendees.find((a) => a.payment_utr === cleanUtr && a.id !== storeAttendee.id);
    if (duplicate) {
      const err: any = new Error('This transaction reference has already been submitted.');
      err.statusCode = 409;
      throw err;
    }

    storeAttendee.payment_utr = cleanUtr;
    storeAttendee.payment_status = 'PAYMENT_SUBMITTED';
    storeAttendee.payment_submitted_at = now;
    storeAttendee.updated_at = now;

    store.audit_logs.push({
      id: store.audit_logs.length + 1,
      attendee_id: storeAttendee.id,
      action: 'PAYMENT_UTR_SUBMITTED',
      details: `Student submitted 12-digit payment UTR: ${maskedUtr}. Waiting for admin verification.`,
      created_at: now,
    });

    saveLocalStore(store);
    return storeAttendee;
  }
}

/**
 * Admin Verification of Payment Reference
 * Atomically transitions payment_status = PAID, allocates FM26-XXX ticket ID, generates scannable QR token.
 * Idempotent: If already verified, returns existing ticket without duplicates.
 */
export async function verifyPaymentAdmin(params: {
  attendeeId: number;
  adminEmail: string;
  adminId?: number;
}): Promise<{ attendee: Attendee; isNewPass: boolean }> {
  const { attendeeId, adminEmail, adminId } = params;

  const attendee = await getAttendeeById(attendeeId);
  if (!attendee) {
    throw new Error(`Attendee #${attendeeId} not found.`);
  }
  if (attendee.payment_status !== 'PAYMENT_SUBMITTED' || !attendee.payment_utr) {
    throw new Error('Only a submitted payment reference can be verified through the admin fallback.');
  }

  return markPaymentSuccessfulAndGeneratePass({
    registrationId: attendeeId,
    confirmedBy: adminEmail,
    paymentMethod: 'admin_verified_upi',
    isManualOverride: true,
    overrideReason: 'Official Payment Verification Approved by Admin',
    adminId,
  });
}

/**
 * Admin Rejection of Payment Reference
 * Transitions payment_status = REJECTED, does NOT generate ticket.
 */
export async function rejectPaymentAdmin(params: {
  attendeeId: number;
  adminEmail: string;
  adminId?: number;
  reason?: string;
}): Promise<Attendee> {
  const { attendeeId, adminEmail, adminId, reason } = params;
  const cleanReason = String(reason || 'Payment reference could not be verified in bank statement').trim();
  const now = new Date().toISOString();

  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM attendees WHERE id = ?',
      [attendeeId]
    );
    if (rows.length === 0) throw new Error(`Attendee #${attendeeId} not found.`);

    await mysqlPool.query(
      `UPDATE attendees
       SET payment_status = 'REJECTED',
           entry_pass_status = 'NOT_CREATED',
           ticket_status = 'NOT_GENERATED',
           rejection_reason = ?,
           payment_confirmed_at = NOW(),
           payment_confirmed_by = ?
       WHERE id = ?`,
      [cleanReason, adminEmail, attendeeId]
    );

    await mysqlPool.query(
      `INSERT INTO audit_logs (admin_id, attendee_id, action, details)
       VALUES (?, ?, 'PAYMENT_REJECTED', ?)`,
      [adminId || null, attendeeId, `Payment rejected by ${adminEmail}. Reason: ${cleanReason}`]
    );

    const [updated] = await mysqlPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM attendees WHERE id = ?',
      [attendeeId]
    );
    return updated[0] as Attendee;
  } else {
    const store = loadLocalStore();
    const attendee = store.attendees.find((a) => a.id === attendeeId);
    if (!attendee) throw new Error(`Attendee #${attendeeId} not found.`);

    attendee.payment_status = 'REJECTED';
    attendee.entry_pass_status = 'NOT_CREATED';
    attendee.ticket_status = 'NOT_GENERATED';
    attendee.rejection_reason = cleanReason;
    attendee.payment_confirmed_at = now;
    attendee.payment_confirmed_by = adminEmail;
    attendee.updated_at = now;

    store.audit_logs.push({
      id: store.audit_logs.length + 1,
      admin_id: adminId,
      attendee_id: attendeeId,
      action: 'PAYMENT_REJECTED',
      details: `Payment rejected by ${adminEmail}. Reason: ${cleanReason}`,
      created_at: now,
    });

    saveLocalStore(store);
    return attendee;
  }
}

/**
 * Requirement 10: Emergency Admin Manual Payment Override
 * Requires authenticated admin, admin ID, timestamp, and mandatory audit reason.
 * Distinctly logs PAYMENT_MANUALLY_CONFIRMED.
 */
export async function confirmPaymentManualOverride(params: {
  attendeeId: number;
  adminId: number;
  adminEmail: string;
  reason: string;
}): Promise<Attendee | null> {
  const { attendeeId, adminId, adminEmail, reason } = params;
  if (!reason || reason.trim().length < 5) {
    throw new Error('A detailed justification (min 5 characters) is required for emergency manual payment override.');
  }

  const res = await markPaymentSuccessfulAndGeneratePass({
    registrationId: attendeeId,
    confirmedBy: adminEmail,
    paymentMethod: 'admin_manual_override',
    isManualOverride: true,
    overrideReason: reason.trim(),
    adminId,
  });

  return res.attendee;
}

/**
 * Backward-compatible wrapper for manual payment confirmation
 */
export async function confirmPayment(attendeeId: number, adminEmail: string, reason?: string, adminId?: number): Promise<Attendee | null> {
  return confirmPaymentManualOverride({
    attendeeId,
    adminId: adminId || 1,
    adminEmail,
    reason: reason || 'Manual payment reconciliation confirmed by admin',
  });
}

/**
 * Requirement 12: Admin Refund & Entry Pass Revocation
 * Sets payment_status = REFUNDED and entry_pass_status = REVOKED
 * Scanning a revoked pass will immediately reject admission at turnstiles.
 */
export async function refundPaymentAndRevokePass(params: {
  attendeeId: number;
  adminId: number;
  adminEmail: string;
  reason: string;
}): Promise<{ success: boolean; attendee: Attendee }> {
  const { attendeeId, adminId, adminEmail, reason } = params;
  if (!reason || reason.trim().length < 5) {
    throw new Error('A reason for refund and ticket revocation is mandatory.');
  }

  if (isUsingMySQL() && mysqlPool) {
    const conn = await mysqlPool.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT * FROM attendees WHERE id = ? FOR UPDATE',
        [attendeeId]
      );

      if (rows.length === 0) {
        await conn.rollback();
        throw new Error(`Attendee #${attendeeId} not found.`);
      }

      await conn.query(
        `UPDATE attendees 
         SET payment_status = 'REFUNDED',
             entry_pass_status = 'REVOKED'
         WHERE id = ?`,
        [attendeeId]
      );

      await conn.query(
        `UPDATE payment_transactions 
         SET status = 'REFUNDED' 
         WHERE registration_id = ?`,
        [attendeeId]
      );

      await conn.query(
        `INSERT INTO audit_logs (admin_id, attendee_id, action, details)
         VALUES (?, ?, 'PAYMENT_REFUNDED_PASS_REVOKED', ?)`,
        [adminId, attendeeId, `Pass revoked and marked REFUNDED by ${adminEmail}. Reason: ${reason}`]
      );

      await conn.commit();

      const [updatedRows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT * FROM attendees WHERE id = ?',
        [attendeeId]
      );
      return { success: true, attendee: updatedRows[0] as Attendee };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    const store = loadLocalStore();
    const attendee = store.attendees.find((a) => a.id === attendeeId);
    if (!attendee) throw new Error(`Attendee #${attendeeId} not found.`);

    attendee.payment_status = 'REFUNDED';
    attendee.entry_pass_status = 'REVOKED';
    attendee.updated_at = new Date().toISOString();

    const tx = store.payment_transactions.find((t) => t.registration_id === attendeeId);
    if (tx) {
      tx.status = 'REFUNDED';
      tx.updated_at = new Date().toISOString();
    }

    store.audit_logs.push({
      id: store.audit_logs.length + 1,
      admin_id: adminId,
      attendee_id: attendeeId,
      action: 'PAYMENT_REFUNDED_PASS_REVOKED',
      details: `Pass revoked and marked REFUNDED by ${adminEmail}. Reason: ${reason}`,
      created_at: new Date().toISOString(),
    });

    saveLocalStore(store);
    return { success: true, attendee };
  }
}

/**
 * Verify QR Token against MySQL
 * Only allows entry if payment_status is PAID and entry_pass_status is ACTIVE
 */
export async function verifyQrToken(qrToken: string): Promise<VerifyQrResult> {
  const token = qrToken.trim();
  if (!token) {
    return { status: 'INVALID', message: 'Empty or invalid QR code format.' };
  }

  let attendee: Attendee | null = null;

  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>('SELECT * FROM attendees WHERE qr_token = ?', [token]);
    if (rows.length > 0) {
      attendee = rows[0] as Attendee;
    }
  } else {
    const store = loadLocalStore();
    attendee = store.attendees.find((a) => a.qr_token && a.qr_token === token) || null;
  }

  if (!attendee) {
    return {
      status: 'INVALID',
      message: '❌ INVALID TICKET: QR Token does not exist in registry.',
    };
  }

  if (attendee.entry_pass_status === 'REVOKED' || attendee.ticket_status === 'REVOKED') {
    return {
      status: 'ENTRY_PASS_REVOKED',
      message: '❌ ENTRY PASS REVOKED: This pass has been cancelled or refunded.',
      attendee: {
        id: attendee.id,
        registration_id: attendee.registration_id,
        ticket_id: attendee.ticket_id,
        full_name: attendee.full_name,
        category: attendee.category,
        college: attendee.college,
        phone: attendee.phone,
        email: attendee.email,
        payment_status: attendee.payment_status,
        entry_pass_status: attendee.entry_pass_status,
        check_in_status: attendee.check_in_status,
        check_in_time: attendee.check_in_time,
        payment_confirmed_at: attendee.payment_confirmed_at,
      },
    };
  }

  if (attendee.check_in_status === 'CHECKED_IN' || attendee.ticket_status === 'USED') {
    return {
      status: 'ALREADY_CHECKED_IN',
      message: '⚠️ ALREADY CHECKED IN: Ticket was admitted previously.',
      attendee: {
        id: attendee.id,
        registration_id: attendee.registration_id,
        ticket_id: attendee.ticket_id,
        full_name: attendee.full_name,
        category: attendee.category,
        college: attendee.college,
        phone: attendee.phone,
        email: attendee.email,
        payment_status: attendee.payment_status,
        entry_pass_status: attendee.entry_pass_status,
        check_in_status: attendee.check_in_status,
        check_in_time: attendee.check_in_time,
        payment_confirmed_at: attendee.payment_confirmed_at,
      },
    };
  }

  if (attendee.payment_status !== 'PAID' || attendee.entry_pass_status === 'NOT_CREATED') {
    return {
      status: 'PAYMENT_NOT_CONFIRMED',
      message: '⚠️ PAYMENT NOT CONFIRMED: Pass is not active until payment is confirmed.',
      attendee: {
        id: attendee.id,
        registration_id: attendee.registration_id,
        ticket_id: attendee.ticket_id,
        full_name: attendee.full_name,
        category: attendee.category,
        college: attendee.college,
        phone: attendee.phone,
        email: attendee.email,
        payment_status: attendee.payment_status,
        entry_pass_status: attendee.entry_pass_status,
        check_in_status: attendee.check_in_status,
        check_in_time: attendee.check_in_time,
        payment_confirmed_at: attendee.payment_confirmed_at,
      },
    };
  }

  return {
    status: 'VALID',
    message: '✅ VALID TICKET: Authorized for admission.',
    attendee: {
      id: attendee.id,
      registration_id: attendee.registration_id,
      ticket_id: attendee.ticket_id,
      full_name: attendee.full_name,
      category: attendee.category,
      college: attendee.college,
      phone: attendee.phone,
      email: attendee.email,
      payment_status: attendee.payment_status,
      entry_pass_status: attendee.entry_pass_status,
      check_in_status: attendee.check_in_status,
      check_in_time: attendee.check_in_time,
      payment_confirmed_at: attendee.payment_confirmed_at,
    },
  };
}

/**
 * Performs atomic Check-In with transaction and row locking
 */
export async function performCheckIn(
  attendeeId: number,
  checkedInByAdmin: string
): Promise<{ success: boolean; message: string; attendee?: Attendee; alreadyCheckedInAt?: string }> {
  if (isUsingMySQL() && mysqlPool) {
    const conn = await mysqlPool.getConnection();
    try {
      await conn.beginTransaction();

      // Lock row FOR UPDATE to prevent race conditions
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT * FROM attendees WHERE id = ? FOR UPDATE',
        [attendeeId]
      );

      if (rows.length === 0) {
        await conn.rollback();
        return { success: false, message: 'Ticket record not found.' };
      }

      const attendee = rows[0] as Attendee;

      if (attendee.entry_pass_status === 'REVOKED') {
        await conn.rollback();
        return { success: false, message: 'Cannot check in: Entry pass has been revoked.' };
      }

      if (attendee.check_in_status === 'CHECKED_IN' || attendee.ticket_status === 'USED') {
        await conn.rollback();
        return {
          success: false,
          message: '⚠️ ALREADY CHECKED IN: This pass was already admitted.',
          alreadyCheckedInAt: attendee.check_in_time || 'Earlier session',
          attendee,
        };
      }

      if (attendee.payment_status !== 'PAID' || !attendee.ticket_id) {
        await conn.rollback();
        return { success: false, message: 'Cannot check in: Payment status is PENDING or ticket not issued.' };
      }

      // Mark as CHECKED_IN
      await conn.query(
        `UPDATE attendees 
         SET check_in_status = 'CHECKED_IN',
             entry_pass_status = 'CHECKED_IN',
             ticket_status = 'USED',
             checked_in_by = ?,
             check_in_time = NOW() 
         WHERE id = ?`,
        [checkedInByAdmin, attendeeId]
      );

      // Insert audit record
      await conn.query(
        `INSERT INTO checkins (attendee_id, ticket_id, checked_in_by, check_in_time)
         VALUES (?, ?, ?, NOW())`,
        [attendeeId, attendee.ticket_id, checkedInByAdmin]
      );

      await conn.commit();

      const [updatedRows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT * FROM attendees WHERE id = ?',
        [attendeeId]
      );
      return {
        success: true,
        message: '✅ CHECKED IN: Gate admission confirmed.',
        attendee: updatedRows[0] as Attendee,
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    // Local fallback with synchronous locking
    const store = loadLocalStore();
    const attendee = store.attendees.find((a) => a.id === attendeeId);
    if (!attendee) return { success: false, message: 'Ticket record not found.' };

    if (attendee.entry_pass_status === 'REVOKED') {
      return { success: false, message: 'Cannot check in: Entry pass has been revoked.' };
    }

    if (attendee.check_in_status === 'CHECKED_IN' || attendee.ticket_status === 'USED') {
      return {
        success: false,
        message: '⚠️ ALREADY CHECKED IN: This pass was already admitted.',
        alreadyCheckedInAt: attendee.check_in_time || 'Earlier session',
        attendee,
      };
    }

    if (attendee.payment_status !== 'PAID' || !attendee.ticket_id) {
      return { success: false, message: 'Cannot check in: Payment is not confirmed.' };
    }

    const now = new Date().toISOString();
    attendee.check_in_status = 'CHECKED_IN';
    attendee.entry_pass_status = 'CHECKED_IN';
    attendee.ticket_status = 'USED';
    attendee.check_in_time = now;
    attendee.checked_in_by = checkedInByAdmin;
    attendee.updated_at = now;

    store.checkins.push({
      id: store.checkins.length + 1,
      attendee_id: attendee.id,
      ticket_id: attendee.ticket_id,
      checked_in_by: checkedInByAdmin,
      check_in_time: now,
    });

    saveLocalStore(store);
    return {
      success: true,
      message: '✅ CHECKED IN: Gate admission confirmed.',
      attendee,
    };
  }
}

/**
 * Calculates Dashboard Statistics including detailed payment pipeline statuses
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(`
      SELECT 
        COUNT(*) AS total_registered,
        SUM(CASE WHEN payment_status = 'PENDING' THEN 1 ELSE 0 END) AS pending_payments,
        SUM(CASE WHEN payment_status = 'PAYMENT_SUBMITTED' THEN 1 ELSE 0 END) AS submitted_payments,
        SUM(CASE WHEN payment_status = 'PROCESSING' THEN 1 ELSE 0 END) AS processing_payments,
        SUM(CASE WHEN payment_status = 'PAID' THEN 1 ELSE 0 END) AS successful_payments,
        SUM(CASE WHEN payment_status = 'FAILED' THEN 1 ELSE 0 END) AS failed_payments,
        SUM(CASE WHEN payment_status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired_payments,
        SUM(CASE WHEN payment_status = 'REFUNDED' THEN 1 ELSE 0 END) AS refunded_payments,
        SUM(CASE WHEN payment_status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected_payments,
        SUM(CASE WHEN entry_pass_status = 'ACTIVE' OR entry_pass_status = 'CHECKED_IN' THEN 1 ELSE 0 END) AS active_entry_passes,
        SUM(CASE WHEN check_in_status = 'CHECKED_IN' THEN 1 ELSE 0 END) AS total_checked_in,
        SUM(CASE WHEN check_in_status = 'NOT_CHECKED_IN' THEN 1 ELSE 0 END) AS not_checked_in,
        SUM(CASE WHEN category = 'FRESHER' THEN 1 ELSE 0 END) AS total_freshers,
        SUM(CASE WHEN category = 'SENIOR' THEN 1 ELSE 0 END) AS total_seniors,
        SUM(CASE WHEN ticket_id IS NOT NULL AND payment_status = 'PAID' THEN 1 ELSE 0 END) AS tickets_generated,
        SUM(CASE WHEN ticket_status = 'UNUSED' THEN 1 ELSE 0 END) AS tickets_unused,
        SUM(CASE WHEN ticket_status = 'USED' THEN 1 ELSE 0 END) AS tickets_used
      FROM attendees
    `);
    const r = rows[0];
    return {
      total_registered: Number(r.total_registered || 0),
      pending_payments: Number(r.pending_payments || 0),
      submitted_payments: Number(r.submitted_payments || 0),
      processing_payments: Number(r.processing_payments || 0),
      successful_payments: Number(r.successful_payments || 0),
      failed_payments: Number(r.failed_payments || 0),
      expired_payments: Number(r.expired_payments || 0),
      refunded_payments: Number(r.refunded_payments || 0),
      rejected_payments: Number(r.rejected_payments || 0),
      active_entry_passes: Number(r.active_entry_passes || 0),
      total_checked_in: Number(r.total_checked_in || 0),
      not_checked_in: Number(r.not_checked_in || 0),
      total_freshers: Number(r.total_freshers || 0),
      total_seniors: Number(r.total_seniors || 0),
      tickets_generated: Number(r.tickets_generated || 0),
      tickets_unused: Number(r.tickets_unused || 0),
      tickets_used: Number(r.tickets_used || 0),
    };
  } else {
    const store = loadLocalStore();
    const atts = store.attendees;
    return {
      total_registered: atts.length,
      pending_payments: atts.filter((a) => a.payment_status === 'PENDING').length,
      submitted_payments: atts.filter((a) => a.payment_status === 'PAYMENT_SUBMITTED').length,
      processing_payments: atts.filter((a) => a.payment_status === 'PROCESSING').length,
      successful_payments: atts.filter((a) => a.payment_status === 'PAID').length,
      failed_payments: atts.filter((a) => a.payment_status === 'FAILED').length,
      expired_payments: atts.filter((a) => a.payment_status === 'EXPIRED').length,
      refunded_payments: atts.filter((a) => a.payment_status === 'REFUNDED').length,
      rejected_payments: atts.filter((a) => a.payment_status === 'REJECTED').length,
      active_entry_passes: atts.filter((a) => a.entry_pass_status === 'ACTIVE' || a.entry_pass_status === 'CHECKED_IN').length,
      total_checked_in: atts.filter((a) => a.check_in_status === 'CHECKED_IN').length,
      not_checked_in: atts.filter((a) => a.check_in_status === 'NOT_CHECKED_IN').length,
      total_freshers: atts.filter((a) => a.category === 'FRESHER').length,
      total_seniors: atts.filter((a) => a.category === 'SENIOR').length,
      tickets_generated: atts.filter((a) => a.ticket_id && a.payment_status === 'PAID').length,
      tickets_unused: atts.filter((a) => a.ticket_status === 'UNUSED').length,
      tickets_used: atts.filter((a) => a.ticket_status === 'USED').length,
    };
  }
}

/**
 * Filter and search attendees
 */
export async function listAttendees(params: {
  search?: string;
  category?: string;
  paymentStatus?: string;
  checkInStatus?: string;
  limit?: number;
  offset?: number;
}): Promise<{ attendees: Attendee[]; total: number }> {
  const { search, category, paymentStatus, checkInStatus, limit = 50, offset = 0 } = params;

  if (isUsingMySQL() && mysqlPool) {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (search && search.trim()) {
      const s = `%${search.trim()}%`;
      conditions.push('(ticket_id LIKE ? OR registration_id LIKE ? OR full_name LIKE ? OR phone LIKE ? OR email LIKE ? OR college LIKE ? OR course_class LIKE ? OR payment_utr LIKE ?)');
      values.push(s, s, s, s, s, s, s, s);
    }

    if (category && category !== 'ALL') {
      conditions.push('category = ?');
      values.push(category);
    }

    if (paymentStatus && paymentStatus !== 'ALL') {
      conditions.push('payment_status = ?');
      values.push(paymentStatus);
    }

    if (checkInStatus && checkInStatus !== 'ALL') {
      conditions.push('check_in_status = ?');
      values.push(checkInStatus);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countRows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) as cnt FROM attendees ${whereClause}`,
      values
    );
    const total = Number(countRows[0].cnt || 0);

    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>(
      `SELECT * FROM attendees ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    return { attendees: rows as Attendee[], total };
  } else {
    const store = loadLocalStore();
    let filtered = [...store.attendees];

    if (search && search.trim()) {
      const s = search.trim().toLowerCase();
      filtered = filtered.filter(
        (a) =>
          (a.ticket_id && a.ticket_id.toLowerCase().includes(s)) ||
          (a.registration_id && a.registration_id.toLowerCase().includes(s)) ||
          a.full_name.toLowerCase().includes(s) ||
          a.phone.toLowerCase().includes(s) ||
          a.email.toLowerCase().includes(s) ||
          (a.college && a.college.toLowerCase().includes(s)) ||
          (a.course_class && a.course_class.toLowerCase().includes(s)) ||
          (a.payment_utr && a.payment_utr.toLowerCase().includes(s))
      );
    }

    if (category && category !== 'ALL') {
      filtered = filtered.filter((a) => a.category === category);
    }

    if (paymentStatus && paymentStatus !== 'ALL') {
      filtered = filtered.filter((a) => a.payment_status === paymentStatus);
    }

    if (checkInStatus && checkInStatus !== 'ALL') {
      filtered = filtered.filter((a) => a.check_in_status === checkInStatus);
    }

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);
    return { attendees: paginated, total };
  }
}

/**
 * Fetch attendee by internal numeric ID
 */
export async function getAttendeeById(id: number): Promise<Attendee | null> {
  if (isUsingMySQL() && mysqlPool) {
    const [rows] = await mysqlPool.query<mysql.RowDataPacket[]>('SELECT * FROM attendees WHERE id = ?', [id]);
    return rows.length > 0 ? (rows[0] as Attendee) : null;
  } else {
    const store = loadLocalStore();
    return store.attendees.find((a) => a.id === id) || null;
  }
}

export async function getEventSettings(): Promise<EventSettings> {
  return getCachedEventSettings();
}

export async function updateEventSettings(params: {
  time: string;
  venue: string;
  registrationPrice: number;
  adminId?: number;
  adminEmail?: string;
  ipAddress?: string;
}): Promise<EventSettings> {
  const time = params.time.trim();
  const venue = params.venue.trim();
  const registrationPrice = Number(params.registrationPrice);

  if (!time || time.length > 100) throw new Error('Event time must be between 1 and 100 characters.');
  if (!venue || venue.length > 500) throw new Error('Venue must be between 1 and 500 characters.');
  if (!Number.isFinite(registrationPrice) || registrationPrice <= 0 || registrationPrice > 100000) {
    throw new Error('Registration price must be a valid amount greater than ₹0 and no more than ₹100000.');
  }

  if (isUsingMySQL() && mysqlPool) {
    const connection = await mysqlPool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        `UPDATE event_settings
         SET event_time = ?, venue = ?, registration_price = ?
         WHERE id = 1`,
        [time, venue, registrationPrice]
      );

      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT event_time, venue, registration_price, updated_at FROM event_settings WHERE id = 1 LIMIT 1'
      );
      if (!rows.length) throw new Error('Event settings record not found.');

      if (params.adminId || params.adminEmail) {
        const previous = getCachedEventSettings();
        const details = JSON.stringify({
          previous,
          next: { time, venue, registrationPrice },
          changedBy: params.adminEmail || null,
        });
        await connection.query(
          `INSERT INTO audit_logs (admin_id, action, details, ip_address) VALUES (?, ?, ?, ?)`,
          [params.adminId || null, 'EVENT_SETTINGS_UPDATED', details, params.ipAddress || null]
        );
      }

      await connection.commit();
      const updated = {
        time: String(rows[0].event_time),
        venue: String(rows[0].venue),
        registrationPrice: Number(rows[0].registration_price),
        updatedAt: new Date(rows[0].updated_at).toISOString(),
      };
      setCachedEventSettings(updated);
      return updated;
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }

  const store = loadLocalStore();
  const previous = store.event_settings || getCachedEventSettings();
  const updated: EventSettings = {
    time,
    venue,
    registrationPrice,
    updatedAt: new Date().toISOString(),
  };
  store.event_settings = updated;
  if (params.adminId || params.adminEmail) {
    store.audit_logs.push({
      id: store.audit_logs.length + 1,
      admin_id: params.adminId || null,
      action: 'EVENT_SETTINGS_UPDATED',
      details: JSON.stringify({ previous, next: updated, changedBy: params.adminEmail || null }),
      ip_address: params.ipAddress || null,
      created_at: updated.updatedAt,
    });
  }
  saveLocalStore(store);
  setCachedEventSettings(updated);
  return updated;
}
