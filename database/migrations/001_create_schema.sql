-- ==============================================================================
-- MSAP 53rd Freshers' Meet 2026 - Netlify Database (PostgreSQL) Initial Schema
-- Migration: 001_create_schema.sql
-- ==============================================================================

-- 1. Automatic Timestamp Update Trigger Function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Administrators Table
CREATE TABLE IF NOT EXISTS "admins" (
  "id" SERIAL PRIMARY KEY,
  "email" VARCHAR(255) NOT NULL UNIQUE,
  "password_hash" VARCHAR(255) NOT NULL,
  "role" VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_admins_email" ON "admins" ("email");

-- 3. Ticket Counter Table (Atomic ID Generation)
CREATE TABLE IF NOT EXISTS "ticket_counter" (
  "id" INT PRIMARY KEY,
  "current_number" INT NOT NULL DEFAULT 0
);

-- 4. Event Settings Table
CREATE TABLE IF NOT EXISTS "event_settings" (
  "id" INT PRIMARY KEY,
  "event_time" VARCHAR(100) NOT NULL,
  "venue" VARCHAR(500) NOT NULL,
  "registration_price" DECIMAL(10, 2) NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_event_settings_updated_at ON "event_settings";
CREATE TRIGGER update_event_settings_updated_at
  BEFORE UPDATE ON "event_settings"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 5. Attendees Table
CREATE TABLE IF NOT EXISTS "attendees" (
  "id" SERIAL PRIMARY KEY,
  "ticket_id" VARCHAR(50) NULL UNIQUE,
  "full_name" VARCHAR(255) NOT NULL,
  "phone" VARCHAR(50) NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "college" VARCHAR(255) NOT NULL,
  "registration_id" VARCHAR(50) NULL UNIQUE,
  "course_class" VARCHAR(255) NULL,
  "academic_year" VARCHAR(100) NULL,
  "category" TEXT NOT NULL DEFAULT 'FRESHER' CHECK ("category" IN ('FRESHER', 'SENIOR')),
  "payment_status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("payment_status" IN ('PENDING', 'PAYMENT_SUBMITTED', 'PROCESSING', 'PAID', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'REFUNDED')),
  "entry_pass_status" TEXT NOT NULL DEFAULT 'NOT_CREATED' CHECK ("entry_pass_status" IN ('NOT_CREATED', 'ACTIVE', 'CHECKED_IN', 'REVOKED')),
  "ticket_status" TEXT NOT NULL DEFAULT 'NOT_GENERATED' CHECK ("ticket_status" IN ('NOT_GENERATED', 'UNUSED', 'USED', 'REVOKED')),
  "registration_status" TEXT NOT NULL DEFAULT 'REGISTERED' CHECK ("registration_status" IN ('REGISTERED', 'CANCELLED')),
  "qr_token" VARCHAR(255) NULL UNIQUE,
  "access_token" VARCHAR(255) NOT NULL UNIQUE,
  "check_in_status" TEXT NOT NULL DEFAULT 'NOT_CHECKED_IN' CHECK ("check_in_status" IN ('NOT_CHECKED_IN', 'CHECKED_IN')),
  "google_response_id" VARCHAR(255) NULL UNIQUE,
  "student_roll_id" VARCHAR(100) NULL,
  "payment_utr" VARCHAR(100) NULL,
  "payment_submitted_at" TIMESTAMPTZ NULL,
  "payment_confirmed_at" TIMESTAMPTZ NULL,
  "payment_confirmed_by" VARCHAR(255) NULL,
  "rejection_reason" TEXT NULL,
  "check_in_time" TIMESTAMPTZ NULL,
  "checked_in_by" VARCHAR(255) NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_attendees_updated_at ON "attendees";
CREATE TRIGGER update_attendees_updated_at
  BEFORE UPDATE ON "attendees"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS "idx_attendees_registration_id" ON "attendees" ("registration_id");
CREATE INDEX IF NOT EXISTS "idx_attendees_ticket_id" ON "attendees" ("ticket_id");
CREATE INDEX IF NOT EXISTS "idx_attendees_qr_token" ON "attendees" ("qr_token");
CREATE INDEX IF NOT EXISTS "idx_attendees_access_token" ON "attendees" ("access_token");
CREATE INDEX IF NOT EXISTS "idx_attendees_phone" ON "attendees" ("phone");
CREATE INDEX IF NOT EXISTS "idx_attendees_email" ON "attendees" ("email");
CREATE INDEX IF NOT EXISTS "idx_attendees_payment_status" ON "attendees" ("payment_status");
CREATE INDEX IF NOT EXISTS "idx_attendees_entry_pass_status" ON "attendees" ("entry_pass_status");
CREATE INDEX IF NOT EXISTS "idx_attendees_check_in_status" ON "attendees" ("check_in_status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_unique_attendees_payment_utr" ON "attendees" ("payment_utr") WHERE "payment_utr" IS NOT NULL;

-- 6. Payment Transactions Table
CREATE TABLE IF NOT EXISTS "payment_transactions" (
  "id" SERIAL PRIMARY KEY,
<<<<<<< HEAD
  "registration_id" INT NOT NULL REFERENCES "attendees" ("id") ON DELETE CASCADE,
=======
  "registration_id" INT NOT NULL,
>>>>>>> a06c5a4d5a47dacfd80b29f49a2a494b30b8c7ad
  "gateway_provider" VARCHAR(50) NOT NULL DEFAULT 'razorpay',
  "gateway_order_id" VARCHAR(100) NOT NULL,
  "gateway_payment_id" VARCHAR(100) NULL,
  "gateway_signature" VARCHAR(255) NULL,
  "amount" DECIMAL(10, 2) NOT NULL DEFAULT 350.00,
  "currency" VARCHAR(10) NOT NULL DEFAULT 'INR',
  "payment_method" VARCHAR(50) NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'PAYMENT_SUBMITTED', 'PROCESSING', 'PAID', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'REFUNDED')),
  "gateway_event_id" VARCHAR(100) NULL UNIQUE,
  "paid_at" TIMESTAMPTZ NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_payment_transactions_updated_at ON "payment_transactions";
CREATE TRIGGER update_payment_transactions_updated_at
  BEFORE UPDATE ON "payment_transactions"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS "idx_tx_reg_id" ON "payment_transactions" ("registration_id");
CREATE INDEX IF NOT EXISTS "idx_tx_order_id" ON "payment_transactions" ("gateway_order_id");
CREATE INDEX IF NOT EXISTS "idx_tx_payment_id" ON "payment_transactions" ("gateway_payment_id");
CREATE INDEX IF NOT EXISTS "idx_tx_status" ON "payment_transactions" ("status");

-- 7. Check-ins Table
CREATE TABLE IF NOT EXISTS "checkins" (
  "id" SERIAL PRIMARY KEY,
  "attendee_id" INT NOT NULL REFERENCES "attendees" ("id") ON DELETE CASCADE,
  "ticket_id" VARCHAR(50) NOT NULL,
  "checked_in_by" VARCHAR(255) NOT NULL,
  "check_in_time" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_checkins_ticket_id" ON "checkins" ("ticket_id");
CREATE INDEX IF NOT EXISTS "idx_checkins_attendee_id" ON "checkins" ("attendee_id");

-- 8. Audit Logs Table
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" SERIAL PRIMARY KEY,
  "admin_id" INT NULL,
  "attendee_id" INT NULL,
  "action" VARCHAR(100) NOT NULL,
  "details" TEXT NULL,
  "ip_address" VARCHAR(50) NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_audit_action" ON "audit_logs" ("action");
CREATE INDEX IF NOT EXISTS "idx_audit_attendee" ON "audit_logs" ("attendee_id");
