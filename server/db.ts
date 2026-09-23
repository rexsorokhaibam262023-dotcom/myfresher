import type mysql from 'mysql2/promise';
import pg from 'pg';
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

// Configure node-postgres parsers for int8 (COUNT) and numeric (SUM) to return JS numbers
pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => parseInt(val, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (val: string) => parseFloat(val));

const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || '';
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_NAME = process.env.DB_NAME || 'msap_freshers_2026';
const DB_USER = process.env.DB_USER || 'msap_user';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

const isProduction = () => process.env.NODE_ENV === 'production';
// Allow local fallback unless the app is explicitly configured to require a database.
// This prevents a missing DB config from breaking registration when the app is being
// run in a local/demo environment without production credentials.
const requireDatabase = () => process.env.REQUIRE_MYSQL === 'true';

export interface QueryResultHeader {
  insertId: number;
  affectedRows: number;
  [key: string]: any;
}
