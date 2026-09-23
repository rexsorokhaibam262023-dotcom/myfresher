import crypto from 'crypto';
import Razorpay from 'razorpay';
import { getCachedEventSettings } from './eventSettings.js';

export interface CreateOrderParams {
  registrationId: number;
  amount?: number; // Optional on input, server resolves the active admin-configured registration price
  currency?: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
}

export interface PaymentOrderResult {
  provider: string;
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  notes?: Record<string, string>;
  isLive: boolean;
}

export interface WebhookVerificationResult {
  isValid: boolean;
  orderId?: string;
  paymentId?: string;
  amount?: number;
  currency?: string;
  status?: 'PAID' | 'FAILED' | 'REFUNDED' | 'EXPIRED';
  paymentMethod?: string;
  eventId?: string;
  rawEvent?: any;
}

/**
 * Production Payment Gateway Service
 * Integrates Razorpay with server-side order creation and payment signature verification.
 * API docs: https://razorpay.com/docs/api/
 */
export class PaymentService {
  private provider: string;
  private keyId: string;
  private keySecret: string;
  private webhookSecret: string;
  private client: Razorpay | null;

  constructor() {
    this.provider = 'razorpay';
    this.keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
    this.keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
    this.webhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
    this.client = this.isConfigured() ? new Razorpay({ key_id: this.keyId, key_secret: this.keySecret }) : null;

    if (this.isConfigured()) {
      console.log(`[PAYMENT] Initialized Razorpay. Key ID: ${this.getMaskedKey()}`);
    } else {
      console.warn(`[PAYMENT CONFIGURATION NOTICE] Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env to accept online payments.`);
    }
  }

  getMaskedKey(): string {
    if (!this.keyId) return 'NOT_CONFIGURED';
    if (this.keyId.length <= 8) return `${this.keyId.substring(0, 4)}...`;
    return `${this.keyId.substring(0, 8)}...${this.keyId.substring(this.keyId.length - 4)}`;
  }

  isConfigured(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }

  getEnvironment(): 'LIVE' | 'NOT_CONFIGURED' {
    if (!this.isConfigured()) return 'NOT_CONFIGURED';
    return 'LIVE';
  }

  getEventTicketPrice(): number {
    return getCachedEventSettings().registrationPrice;
  }

  getProviderName(): string {
    return this.provider;
  }

  getKeyId(): string {
    return this.keyId;
  }

  getKeySecret(): string {
    return this.keySecret;
  }

  getWebhookSecret(): string {
    return this.webhookSecret;
  }

  isLiveMode(): boolean {
    return this.isConfigured() && this.keyId.startsWith('rzp_live_');
  }

  isTestMode(): boolean {
    return !this.isLiveMode();
  }

  /**
   * Creates a payment order via Razorpay Orders API.
   * Server determines price (admin-configured amount).
   * Docs: POST https://api.razorpay.com/v1/orders
   */
  async createPaymentOrder(params: CreateOrderParams): Promise<PaymentOrderResult> {
    const { registrationId, customerName } = params;
    const amount = this.getEventTicketPrice(); // Strictly server-enforced
    const currency = 'INR';

    if (!this.isConfigured() || !this.client) {
      console.error(`[PAYMENT ORDER REJECTED] Razorpay not configured. Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.`);
      throw new Error(
        'Payment gateway is not configured on the server. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.'
      );
    }

    const receipt = `msap_${registrationId}_${Date.now().toString(36)}`;

    try {
      const razorpayOrder = await this.client.orders.create({
        amount: Math.round(amount * 100), // Razorpay expects the smallest currency unit (paise)
        currency,
        receipt,
        notes: {
          registrationId: String(registrationId),
          customerName: customerName.substring(0, 100),
          event: "MSAP 53rd Freshers' Meet 2026",
        },
      });

      console.log(`[PAYMENT ORDER CREATED] regId=${registrationId}, orderId=${razorpayOrder.id}, amount=₹${amount}, provider=Razorpay, key=${this.getMaskedKey()}`);

      return {
        provider: this.provider,
        orderId: razorpayOrder.id,
        amount,
        currency,
        keyId: this.keyId,
        notes: {
          registrationId: String(registrationId),
          event: "MSAP 53rd Freshers' Meet 2026",
        },
        isLive: this.isLiveMode(),
      };
    } catch (err: any) {
      console.error('[PAYMENT ORDER FAILED] Razorpay API error:', err);
      const message = err?.error?.description || (err instanceof Error ? err.message : String(err));
      throw new Error(`Payment gateway order creation failed: ${message}`);
    }
  }

  /**
   * Server-side verification of a Razorpay Checkout callback.
   * Verifies the HMAC-SHA256 signature Razorpay returns to the client handler,
   * then confirms the payment's captured status and amount via the Payments API.
   * Docs: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration/#step-5-verify-payment-signature
   */
  async verifyCheckoutPayment(params: {
    orderId: string;
    paymentId?: string;
    signature?: string;
    registrationId: number;
    expectedAmount?: number;
  }): Promise<{ verified: boolean; error?: string; paymentDetails?: any }> {
    const { orderId, paymentId, signature } = params;
    console.log(`[PAYMENT VERIFY REQUEST] regId=${params.registrationId}, orderId=${orderId}, paymentId=${paymentId}`);

    if (!this.isConfigured() || !this.client) {
      console.error('[PAYMENT VERIFICATION REJECT] Razorpay is not configured.');
      return { verified: false, error: 'Payment gateway is not configured on server.' };
    }

    if (!paymentId || !signature) {
      return { verified: false, error: 'Missing payment ID or signature from checkout response.' };
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (expectedSignature !== signature) {
      console.warn(`[PAYMENT SECURITY FRAUD] Signature mismatch for orderId=${orderId}, paymentId=${paymentId}`);
      return { verified: false, error: 'Payment signature verification failed.' };
    }

    try {
      const payment = await this.client.payments.fetch(paymentId);

      if (payment.order_id !== orderId) {
        return { verified: false, error: 'Payment does not belong to this order.' };
      }

      if (payment.status !== 'captured' && payment.status !== 'authorized') {
        return { verified: false, error: `Payment not successful. Status: ${payment.status}` };
      }

      const storedAmount = Number(params.expectedAmount);
      const expectedAmount = Number.isFinite(storedAmount) && storedAmount > 0
        ? storedAmount
        : this.getEventTicketPrice();
      const paidAmount = Number(payment.amount) / 100;

      if (Number.isFinite(paidAmount) && paidAmount !== expectedAmount) {
        return {
          verified: false,
          error: `Payment amount mismatch: Expected ₹${expectedAmount}, received ₹${paidAmount}. Ticket generation rejected.`,
        };
      }

      return {
        verified: true,
        paymentDetails: {
          ...payment,
          provider: 'razorpay',
        },
      };
    } catch (apiErr: any) {
      console.error('[PAYMENT API VERIFY ERROR] Razorpay check failed:', apiErr);
      const message = apiErr?.error?.description || (apiErr instanceof Error ? apiErr.message : String(apiErr));
      return { verified: false, error: `Gateway verification error: ${message}` };
    }
  }

  /**
   * Verifies the X-Razorpay-Signature header on webhook deliveries.
   * Docs: https://razorpay.com/docs/webhooks/validate-test/
   */
  verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader || !this.webhookSecret) return false;
    const expectedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signatureHeader));
    } catch {
      return false;
    }
  }

  /**
   * Normalizes an incoming Razorpay webhook payload into a uniform verification result.
   * Docs: https://razorpay.com/docs/webhooks/payloads/payments/
   */
  parseWebhookEvent(payload: any): WebhookVerificationResult {
    const entity = payload?.payload?.payment?.entity || {};
    const orderId = entity.order_id;
    const paymentId = entity.id;
    const amount = entity.amount !== undefined ? Number(entity.amount) / 100 : undefined;
    const currency = entity.currency || 'INR';

    const eventName = payload?.event as string | undefined;
    const status = eventName === 'payment.captured'
      ? 'PAID' as const
      : eventName === 'payment.failed'
        ? 'FAILED' as const
        : undefined;

    return {
      isValid: true,
      orderId,
      paymentId,
      amount,
      currency,
      status,
      paymentMethod: entity.method || 'upi',
      eventId: payload?.id || `evt_${orderId}_${Date.now()}`,
      rawEvent: payload,
    };
  }
}

export const paymentService = new PaymentService();
