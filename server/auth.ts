import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { AuthTokenPayload } from './types.js';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (IS_PRODUCTION) {
    if (!secret || secret.includes('default') || secret.length < 32) {
      throw new Error('[FATAL SECURITY ERROR] JWT_SECRET must be configured in environment variables with at least 32 characters for production.');
    }
    return secret;
  }
  if (!secret) {
    console.warn('[SECURITY DEV WARNING] JWT_SECRET not configured. Using local development secret. Configure JWT_SECRET in .env for production.');
    return 'dev_only_jwt_secret_token_msap_freshers_meet_2026_dev_mode';
  }
  return secret;
}

const JWT_SECRET = getJwtSecret();
const SALT_ROUNDS = 10;

export async function hashPassword(plainText: string): Promise<string> {
  return bcrypt.hash(plainText, SALT_ROUNDS);
}

export async function comparePassword(plainText: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plainText, hashed);
}

export function generateAdminToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

export function verifyAdminToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
  } catch {
    return null;
  }
}

export interface AttendeeSessionPayload {
  attendeeId: number;
  registrationId: string;
  type: 'ATTENDEE_SESSION';
}

export function generateAttendeeSessionToken(attendeeId: number, registrationId: string, expiresIn: string = '4h'): string {
  return jwt.sign({ attendeeId, registrationId, type: 'ATTENDEE_SESSION' }, JWT_SECRET, { expiresIn } as jwt.SignOptions);
}

export function verifyAttendeeSessionToken(token: string): AttendeeSessionPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded && decoded.type === 'ATTENDEE_SESSION' && decoded.attendeeId) {
      return decoded as AttendeeSessionPayload;
    }
    return null;
  } catch {
    return null;
  }
}

export interface AuthenticatedRequest extends Request {
  admin?: AuthTokenPayload;
}

export function requireAdminAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers['x-admin-token']) {
    token = req.headers['x-admin-token'] as string;
  } else if (req.cookies && req.cookies.admin_token) {
    token = req.cookies.admin_token;
  }

  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Access Denied: Authentication token required for Admin operations.',
    });
  }

  const decoded = verifyAdminToken(token);
  if (!decoded || (decoded.role !== 'ADMIN' && decoded.role !== 'SUPERADMIN')) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Access Denied: Insufficient administrative privileges.',
    });
  }

  req.admin = decoded;
  next();
}
