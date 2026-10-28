import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { memoryStore } from '@/lib/store';

const SimulateCallbackSchema = z.object({
  checkoutRequestId: z.string().min(1, 'CheckoutRequestID is required'),
  amount: z.number().optional(),
  phoneNumber: z.string().optional(),
  resultCode: z.number().default(0),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = SimulateCallbackSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid parameters', details: parsed.error.format() },
        { status: 400 }
      );
    }

    const { checkoutRequestId, resultCode } = parsed.data;
    const tx = memoryStore.getTransaction(checkoutRequestId);

    const amount = parsed.data.amount || tx?.amount || 4500;
    const phone = parsed.data.phoneNumber || tx?.phone_number || '254712345678';
    const cleanPhone = phone.replace(/\D/g, '');

    const receiptNumber = `QKH${Math.floor(10000000 + Math.random() * 90000000)}`;
    const nowTimestamp = Number(
      new Date().toISOString().replace(/\D/g, '').substring(0, 14)
    );

    // Build standard Safaricom Daraja STK callback payload
    const darajaPayload = {
      Body: {
        stkCallback: {
          MerchantRequestID: tx?.merchant_request_id || `MR-SIM-${Date.now()}`,
          CheckoutRequestID: checkoutRequestId,
          ResultCode: resultCode,
          ResultDesc:
            resultCode === 0
              ? 'The service request is processed successfully.'
              : 'Request cancelled by user or insufficient funds',
          ...(resultCode === 0
            ? {
                CallbackMetadata: {
                  Item: [
                    { Name: 'Amount', Value: amount },
                    { Name: 'MpesaReceiptNumber', Value: receiptNumber },
                    { Name: 'Balance', Value: 0 },
                    { Name: 'TransactionDate', Value: nowTimestamp },
                    { Name: 'PhoneNumber', Value: Number(cleanPhone) },
                  ],
                },
              }
            : {}),
        },
      },
    };

    // Forward to the actual callback handler route
    const origin = req.nextUrl.origin;
    const callbackResponse = await fetch(`${origin}/api/mpesa/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(darajaPayload),
      cache: 'no-store',
    });

    const callbackResult = await callbackResponse.json();

    return NextResponse.json({
      success: callbackResponse.ok,
      simulatedPayload: darajaPayload,
      callbackResult,
      receiptNumber: resultCode === 0 ? receiptNumber : null,
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Simulation error';
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
