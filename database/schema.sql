-- ==========================================================
-- MSAP 53rd Freshers' Meet 2026 - Primary Relational Database Schema
-- Database: msap_freshers_2026
-- Compatible with MySQL 8.0+ / MariaDB 10.5+
-- ==========================================================

CREATE DATABASE IF NOT EXISTS `msap_freshers_2026`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `msap_freshers_2026`;

-- ----------------------------------------------------------
-- 1. Table: admins
-- Secure Administrator accounts with bcrypt hashed passwords
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `admins` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_admins_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------
-- 2. Table: ticket_counter
-- Guarantees atomic, strictly non-colliding sequential ticket IDs
-- (e.g., FM26-001, FM26-002, ...)
-- Increments ONLY when a ticket is confirmed and generated.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `ticket_counter` (
  `id` INT PRIMARY KEY,
  `current_number` INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Initialize counter row if missing
INSERT INTO `ticket_counter` (`id`, `current_number`)
VALUES (1, 0)
ON DUPLICATE KEY UPDATE `id` = `id`;

-- ----------------------------------------------------------
-- 2.5 Table: event_settings
-- Single live event configuration shared by the public site, tickets and payments.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `event_settings` (
  `id` INT PRIMARY KEY,
  `event_time` VARCHAR(100) NOT NULL,
  `venue` VARCHAR(500) NOT NULL,
  `registration_price` DECIMAL(10, 2) NOT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `event_settings` (`id`, `event_time`, `venue`, `registration_price`)
VALUES (1, '5:30 PM Sharp', 'Pune (MSAP Campus Main Auditorium)', 350.00)
ON DUPLICATE KEY UPDATE `id` = `id`;

-- ----------------------------------------------------------
-- 3. Table: attendees
-- Master record of all student & guest registrations
-- ticket_id and qr_token remain NULL until payment is verified PAID.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `attendees` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `registration_id` VARCHAR(50) NULL UNIQUE,
  `ticket_id` VARCHAR(50) NULL UNIQUE,
  `full_name` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(50) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `college` VARCHAR(255) NOT NULL,
  `course_class` VARCHAR(255) NULL,
  `academic_year` VARCHAR(100) NULL,
  `category` ENUM('FRESHER', 'SENIOR') NOT NULL DEFAULT 'FRESHER',
  `payment_status` ENUM('PENDING', 'PAYMENT_SUBMITTED', 'PROCESSING', 'PAID', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
  `entry_pass_status` ENUM('NOT_CREATED', 'ACTIVE', 'CHECKED_IN', 'REVOKED') NOT NULL DEFAULT 'NOT_CREATED',
  `ticket_status` ENUM('NOT_GENERATED', 'UNUSED', 'USED', 'REVOKED') NOT NULL DEFAULT 'NOT_GENERATED',
  `registration_status` ENUM('REGISTERED', 'CANCELLED') NOT NULL DEFAULT 'REGISTERED',
  `qr_token` VARCHAR(255) NULL UNIQUE,
  `access_token` VARCHAR(255) NOT NULL UNIQUE,
  `check_in_status` ENUM('NOT_CHECKED_IN', 'CHECKED_IN') NOT NULL DEFAULT 'NOT_CHECKED_IN',
  `google_response_id` VARCHAR(255) NULL UNIQUE,
  `student_roll_id` VARCHAR(100) NULL,
  `payment_utr` VARCHAR(100) NULL,
  `payment_submitted_at` DATETIME NULL,
  `payment_confirmed_at` DATETIME NULL,
  `payment_confirmed_by` VARCHAR(255) NULL,
  `rejection_reason` TEXT NULL,
  `check_in_time` DATETIME NULL,
  `checked_in_by` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_attendees_registration_id` (`registration_id`),
  INDEX `idx_attendees_ticket_id` (`ticket_id`),
  INDEX `idx_attendees_qr_token` (`qr_token`),
  INDEX `idx_attendees_access_token` (`access_token`),
  INDEX `idx_attendees_phone` (`phone`),
  INDEX `idx_attendees_email` (`email`),
  INDEX `idx_attendees_payment_status` (`payment_status`),
  INDEX `idx_attendees_entry_pass_status` (`entry_pass_status`),
  INDEX `idx_attendees_check_in_status` (`check_in_status`),
  INDEX `idx_attendees_category` (`category`),
  INDEX `idx_attendees_google_response` (`google_response_id`),
  UNIQUE KEY `idx_unique_attendees_payment_utr` (`payment_utr`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------
-- 4. Table: payment_transactions
-- Audit log of all payment attempts, webhooks, and gateway orders
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `payment_transactions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `registration_id` INT NOT NULL,
  `gateway_provider` VARCHAR(50) NOT NULL DEFAULT 'razorpay',
  `gateway_order_id` VARCHAR(100) NOT NULL,
  `gateway_payment_id` VARCHAR(100) NULL,
  `gateway_signature` VARCHAR(255) NULL,
  `amount` DECIMAL(10, 2) NOT NULL DEFAULT 350.00,
  `currency` VARCHAR(10) NOT NULL DEFAULT 'INR',
  `payment_method` VARCHAR(50) NULL,
  `status` ENUM('PENDING', 'PAYMENT_SUBMITTED', 'PROCESSING', 'PAID', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
  `gateway_event_id` VARCHAR(100) NULL UNIQUE,
  `paid_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_tx_reg_id` (`registration_id`),
  INDEX `idx_tx_order_id` (`gateway_order_id`),
  INDEX `idx_tx_payment_id` (`gateway_payment_id`),
  INDEX `idx_tx_status` (`status`),
  CONSTRAINT `fk_transactions_attendee`
    FOREIGN KEY (`registration_id`) REFERENCES `attendees` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------
-- 5. Table: checkins
-- Audit trail of gate admittance actions
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `checkins` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `attendee_id` INT NOT NULL,
  `ticket_id` VARCHAR(50) NOT NULL,
  `checked_in_by` VARCHAR(255) NOT NULL,
  `check_in_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_checkins_ticket_id` (`ticket_id`),
  INDEX `idx_checkins_attendee_id` (`attendee_id`),
  CONSTRAINT `fk_checkins_attendee`
    FOREIGN KEY (`attendee_id`) REFERENCES `attendees` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------
-- 6. Table: audit_logs
-- Immutable audit log of all admin operations and lifecycle events
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `admin_id` INT NULL,
  `attendee_id` INT NULL,
  `action` VARCHAR(100) NOT NULL,
  `details` TEXT NULL,
  `ip_address` VARCHAR(50) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_audit_action` (`action`),
  INDEX `idx_audit_attendee` (`attendee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------
-- Default Admin Seed Note
-- Initial admin account is provisioned dynamically via environment variables
-- ADMIN_DEFAULT_EMAIL and ADMIN_DEFAULT_PASSWORD during application bootstrap
-- in server/db.ts to prevent hardcoding production credentials in schema files.
-- ----------------------------------------------------------
