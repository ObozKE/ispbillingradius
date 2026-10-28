/**
 * Safaricom Daraja M-Pesa API Client
 * Supports STK Push (LIPA NA M-PESA ONLINE) with OAuth token generation
 * and graceful mock fallback for sandbox/local verification.
 */

export interface StkPushOptions {
  phoneNumber: string; // MSISDN in format 2547XXXXXXXX or 07XXXXXXXX
  amount: number;
  accountReference: string;
  transactionDesc?: string;
}

export interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
  isMock?: boolean;
}

const DARAJA_ENV = process.env.DARAJA_ENV || 'sandbox';
const BASE_URL =
  DARAJA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

const CONSUMER_KEY = process.env.DARAJA_CONSUMER_KEY || '';
const CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET || '';
const SHORTCODE = process.env.DARAJA_SHORTCODE || '174379';
const PASSKEY =
  process.env.DARAJA_PASSKEY ||
  'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const CALLBACK_URL =
  process.env.DARAJA_CALLBACK_URL ||
  'http://localhost:3000/api/mpesa/callback';

/**
 * Format local Kenyan mobile numbers to international 254XXXXXXXXX standard
 */
export function normalizePhoneNumber(phone: string): string {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.substring(1);
  } else if (cleaned.startsWith('+254')) {
    cleaned = cleaned.substring(1);
  } else if (!cleaned.startsWith('254') && cleaned.length === 9) {
    cleaned = '254' + cleaned;
  }
  return cleaned;
}

/**
 * Generate formatted Daraja timestamp YYYYMMDDHHmmss
 */
export function getDarajaTimestamp(): string {
  const date = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * Retrieve OAuth 2.0 Bearer access token from Daraja
 */
export async function getDarajaAccessToken(): Promise<string> {
  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    throw new Error('DARAJA_CREDENTIALS_MISSING');
  }

  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

  const response = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Daraja OAuth token request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Dispatch an M-Pesa STK Push request to the subscriber's phone
 */
export async function initiateStkPush({
  phoneNumber,
  amount,
  accountReference,
  transactionDesc = 'ISP Bandwidth Upgrade',
}: StkPushOptions): Promise<StkPushResponse> {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  const timestamp = getDarajaTimestamp();
  const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

  // If live credentials are not provided, use high-fidelity sandbox mock response
  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    const mockCheckoutId = `ws_CO_${timestamp}_${Math.floor(100000 + Math.random() * 900000)}`;
    const mockMerchantId = `MR-${Math.floor(10000 + Math.random() * 90000)}-${Date.now()}`;

    return {
      MerchantRequestID: mockMerchantId,
      CheckoutRequestID: mockCheckoutId,
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing (Sandbox Mock)',
      CustomerMessage: 'Success. Request accepted for processing. Check phone for M-Pesa prompt.',
      isMock: true,
    };
  }

  const accessToken = await getDarajaAccessToken();

  const payload = {
    BusinessShortCode: SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount),
    PartyA: normalizedPhone,
    PartyB: SHORTCODE,
    PhoneNumber: normalizedPhone,
    CallBackURL: CALLBACK_URL,
    AccountReference: accountReference.substring(0, 12),
    TransactionDesc: transactionDesc.substring(0, 13),
  };

  const response = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      `STK Push failed with status ${response.status}: ${JSON.stringify(errorData)}`
    );
  }

  return (await response.json()) as StkPushResponse;
}
