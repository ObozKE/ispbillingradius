import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { initiateStkPush, normalizePhoneNumber } from '@/lib/daraja';
import { memoryStore } from '@/lib/store';

const StkPushRequestSchema = z.object({
  subscriberId: z.string().min(1, 'Subscriber ID is required'),
  targetPlanId: z.string().min(1, 'Target Plan ID is required'),
  phoneNumber: z.string().min(9, 'Phone number must be at least 9 digits'),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = StkPushRequestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Validation failed',
          details: parsed.error.format(),
        },
        { status: 400 }
      );
    }

    const { subscriberId, targetPlanId, phoneNumber } = parsed.data;

    // 1. Resolve Target Plan details for pricing
    let plan = memoryStore.getPlanById(targetPlanId);
    let subscriber = memoryStore.getSubscriber();

    try {
      const { data: dbPlan } = await supabaseAdmin
        .from('bandwidth_plans')
        .select('*')
        .eq('id', targetPlanId)
        .single();
      if (dbPlan) {
        plan = dbPlan;
      }

      const { data: dbSub } = await supabaseAdmin
        .from('subscribers')
        .select('*')
        .eq('id', subscriberId)
        .single();
      if (dbSub) {
        subscriber = dbSub;
      }
    } catch {
      // In local demo without live Supabase, memoryStore fallback is used
    }

    if (!plan) {
      return NextResponse.json(
        { success: false, error: 'Target bandwidth plan not found' },
        { status: 404 }
      );
    }

    // 2. Dispatch STK Push via Daraja M-Pesa client
    const stkResponse = await initiateStkPush({
      phoneNumber,
      amount: plan.price_kes,
      accountReference: subscriber?.username || 'cust_001',
      transactionDesc: `Upgrade to ${plan.rate_limit}`,
    });

    const transactionRecord = {
      checkout_request_id: stkResponse.CheckoutRequestID,
      merchant_request_id: stkResponse.MerchantRequestID,
      amount: plan.price_kes,
      phone_number: normalizePhoneNumber(phoneNumber),
      status: 'PENDING' as const,
      radius_provisioned: false,
      subscriber_id: subscriberId,
      target_plan_id: targetPlanId,
    };

    // 3. Insert transaction into Supabase PostgreSQL
    try {
      await supabaseAdmin.from('mpesa_transactions').insert([transactionRecord]);
    } catch (err) {
      console.warn('Supabase DB insert warning (operating with memory store fallback):', err);
    }

    // Always mirror to in-memory store for local testing
    memoryStore.createTransaction(transactionRecord);

    return NextResponse.json({
      success: true,
      checkoutRequestId: stkResponse.CheckoutRequestID,
      merchantRequestId: stkResponse.MerchantRequestID,
      amount: plan.price_kes,
      rateLimit: plan.rate_limit,
      planName: plan.name,
      customerMessage: stkResponse.CustomerMessage,
      isMock: stkResponse.isMock ?? false,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}
