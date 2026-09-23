export type AttendeeCategory = 'FRESHER' | 'SENIOR';
export type PaymentStatus = 'PENDING' | 'PAYMENT_SUBMITTED' | 'PROCESSING' | 'PAID' | 'VERIFIED' | 'REJECTED' | 'FAILED' | 'EXPIRED' | 'REFUNDED';
export type EntryPassStatus = 'NOT_CREATED' | 'ACTIVE' | 'CHECKED_IN' | 'REVOKED';
export type TicketStatus = 'NOT_GENERATED' | 'UNUSED' | 'USED' | 'REVOKED';
export type CheckInStatus = 'NOT_CHECKED_IN' | 'CHECKED_IN';

export interface Attendee {
  id: number;
  registration_id: string;
  ticket_id: string | null;
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
  registration_status: string;
  qr_token: string | null;
  access_token: string;
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

export interface DigitalPassData {
  registrationId?: string;
  ticketId: string | null;
  fullName: string;
  category: AttendeeCategory;
  college: string;
  courseClass?: string;
  academicYear?: string;
  paymentStatus: PaymentStatus;
  entryPassStatus: EntryPassStatus;
  ticketStatus?: TicketStatus;
  checkInStatus: CheckInStatus;
  checkInTime?: string | null;
  paymentUtr?: string | null;
  paymentSubmittedAt?: string | null;
  rejectionReason?: string | null;
  qrToken?: string | null;
  qrSvg?: string;
  qrDataUrl?: string;
  eventDate: string;
  doorsOpen: string;
  venue: string;
  eventName: string;
  organization: string;
  amount: string;
  orderId?: string | null;
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

export interface VerifyQrResponse {
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

export interface AdminUser {
  id: number;
  email: string;
  role: string;
}
