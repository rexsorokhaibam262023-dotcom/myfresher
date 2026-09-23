/**
 * MSAP 53rd Freshers' Meet 2026 - Data Models & Interfaces
 */

export type AttendeeCategory = 'FRESHER' | 'SENIOR';
export type PaymentStatus = 'PENDING' | 'PAYMENT_SUBMITTED' | 'PROCESSING' | 'PAID' | 'VERIFIED' | 'REJECTED' | 'FAILED' | 'EXPIRED' | 'REFUNDED';
export type EntryPassStatus = 'NOT_CREATED' | 'ACTIVE' | 'CHECKED_IN' | 'REVOKED';
export type TicketStatus = 'NOT_GENERATED' | 'UNUSED' | 'USED' | 'REVOKED';
export type RegistrationStatus = 'REGISTERED' | 'CANCELLED';
export type CheckInStatus = 'NOT_CHECKED_IN' | 'CHECKED_IN';

export interface Attendee {
  id: number;
  registration_id: string; // Formatted unique ID e.g. REG-0001
  ticket_id: string | null; // NULL until payment is verified
  full_name: string;
  phone: string;
  email: string;
  college: string;
  course_class?: string | null;
  academic_year?: string | null;
  category: AttendeeCategory;
  payment_status: PaymentStatus;
  entry_pass_status: EntryPassStatus;
  ticket_status?: TicketStatus;
  registration_status: RegistrationStatus;
  qr_token: string | null; // Cryptographically random secure token, NULL until verified
  access_token: string; // Secure token for user registration/ticket retrieval
  check_in_status: CheckInStatus;
  google_response_id?: string | null;
  student_roll_id?: string | null;
  payment_utr?: string | null;
  payment_submitted_at?: string | null;
  payment_confirmed_at?: string | null;
  payment_confirmed_by?: string | null;
  rejection_reason?: string | null;
  check_in_time?: string | null;
  checked_in_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentTransaction {
  id: number;
  registration_id: number;
  gateway_provider: string;
  gateway_order_id: string;
  gateway_payment_id?: string | null;
  gateway_signature?: string | null;
  amount: number;
  currency: string;
  payment_method?: string | null;
  status: PaymentStatus;
  gateway_event_id?: string | null;
  paid_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminUser {
  id: number;
  email: string;
  password_hash: string;
  role: 'ADMIN' | 'SUPERADMIN';
  created_at: string;
}

export interface CheckinRecord {
  id: number;
  attendee_id: number;
  ticket_id: string;
  checked_in_by: string;
  check_in_time: string;
}

export interface AuditLogRecord {
  id: number;
  admin_id?: number | null;
  attendee_id?: number | null;
  action: string;
  details?: string | null;
  ip_address?: string | null;
  created_at: string;
}

export interface DashboardStats {
  total_registered: number;
  pending_payments: number;
  submitted_payments: number;
  processing_payments: number;
  successful_payments: number;
  rejected_payments: number;
  failed_payments: number;
  expired_payments: number;
  refunded_payments: number;
  active_entry_passes: number;
  tickets_generated: number;
  tickets_unused: number;
  tickets_used: number;
  total_checked_in: number;
  not_checked_in: number;
  total_freshers: number;
  total_seniors: number;
}

export interface CreateRegistrationDTO {
  fullName: string;
  phone: string;
  email: string;
  college: string;
  courseClass?: string;
  academicYear?: string;
  category: AttendeeCategory;
  rollId?: string;
  paymentUtr?: string;
  googleResponseId?: string;
}

export interface CreateRegistrationResult {
  attendee?: Attendee;
  isDuplicate: boolean;
  isPartialDuplicate?: boolean;
  message?: string;
}

export interface VerifyQrResult {
  status: 'VALID' | 'ALREADY_CHECKED_IN' | 'PAYMENT_NOT_CONFIRMED' | 'ENTRY_PASS_REVOKED' | 'INVALID';
  message: string;
  attendee?: {
    id: number;
    registration_id: string;
    ticket_id: string | null;
    full_name: string;
    category: AttendeeCategory;
    college: string;
    course_class?: string | null;
    academic_year?: string | null;
    phone: string;
    email: string;
    payment_status: PaymentStatus;
    entry_pass_status: EntryPassStatus;
    ticket_status?: TicketStatus;
    check_in_status: CheckInStatus;
    check_in_time?: string | null;
    checked_in_by?: string | null;
    payment_confirmed_at?: string | null;
  };
}

export interface EventSettings {
  time: string;
  venue: string;
  registrationPrice: number;
  updatedAt: string;
  upiId?: string;
}

export interface AuthTokenPayload {
  id: number;
  email: string;
  role: string;
}
