import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, BandwidthPlan, Subscriber, MpesaTransaction } from '@/lib/supabase';
import { provisionRadiusSubscriber } from '@/lib/radius-ssh';
import { memoryStore } from '@/lib/store';

interface StkCallbackItem {
  Name: string;
  Value?: string | number;
}

interface StkCallbackBody {
  Body?: {
    stkCallback?: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: {
        Item: StkCallbackItem[];
      };
    };
  };
  // Developer convenience if payload passed without nested Body
  stkCallback?: {
    MerchantRequestID: string;
    CheckoutRequestID: string;
    ResultCode: number;
    ResultDesc: string;
    CallbackMetadata?: {
      Item: StkCallbackItem[];
    };
  };
}

function getItemValue(items: StkCallbackItem[] | undefined, name: string): string | number | null {
  if (!items) return null;
  const match = items.find((item) => item.Name.toLowerCase() === name.toLowerCase());
  return match?.Value ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const rawPayload: StkCallbackBody = await req.json();
    const callbackData = rawPayload.Body?.stkCallback || rawPayload.stkCallback;

    if (!callbackData) {
      return NextResponse.json(
        { ResultCode: 1, ResultDesc: 'Missing stkCallback object' },
        { status: 400 }
      );
    }

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callbackData;

    if (!CheckoutRequestID) {
      return NextResponse.json(
        { ResultCode: 1, ResultDesc: 'Missing CheckoutRequestID' },
        { status: 400 }
      );
    }

    // 1. Fetch transaction record from Supabase or fallback store
    let txRecord: MpesaTransaction | null = null;
    let targetPlan: BandwidthPlan | null = null;
    let subscriber: Subscriber | null = null;

    try {
      const { data: dbTx } = await supabaseAdmin
        .from('mpesa_transactions')
        .select(`
          *,
          subscribers (*),
          bandwidth_plans (*)
        `)
        .eq('checkout_request_id', CheckoutRequestID)
        .single();

      if (dbTx) {
        txRecord = dbTx;
        subscriber = (dbTx.subscribers as unknown as Subscriber) || null;
        targetPlan = (dbTx.bandwidth_plans as unknown as BandwidthPlan) || null;
      }
    } catch {
      // Supabase connection fallback
    }

    if (!txRecord) {
      const memTx = memoryStore.getTransaction(CheckoutRequestID);
      if (memTx) {
        txRecord = memTx;
        targetPlan = memTx.target_plan || memoryStore.getPlanById(memTx.target_plan_id) || null;
        subscriber = memTx.subscriber || memoryStore.getSubscriber();
      }
    }

    if (!txRecord) {
      console.error(`[M-Pesa Webhook] Transaction ${CheckoutRequestID} not found in database.`);
      return NextResponse.json(
        { ResultCode: 1, ResultDesc: 'Transaction not found in ISP records' },
        { status: 404 }
      );
    }

    // 2. Strict Idempotency Check: Already processed?
    if (txRecord.status === 'COMPLETED' && txRecord.radius_provisioned) {
      console.log(
        `[M-Pesa Webhook] Idempotent request ignored: ${CheckoutRequestID} already completed.`
      );
      return NextResponse.json({
        ResultCode: 0,
        ResultDesc: 'Already provisioned (Idempotent acknowledgment)',
      });
    }

    // 3. Handle Failure or Cancellation from Daraja
    if (ResultCode !== 0) {
      console.warn(`[M-Pesa Webhook] Transaction failed by user or Safaricom: ${ResultDesc}`);

      try {
        await supabaseAdmin
          .from('mpesa_transactions')
          .update({
            status: 'FAILED',
            raw_callback_payload: rawPayload,
            completed_at: new Date().toISOString(),
          })
          .eq('checkout_request_id', CheckoutRequestID);
      } catch {
        // Fallback
      }

      memoryStore.failTransaction(CheckoutRequestID, rawPayload as Record<string, unknown>);

      return NextResponse.json({
        ResultCode: 0,
        ResultDesc: `Payment failure acknowledged: ${ResultDesc}`,
      });
    }

    // 4. Extract Callback Metadata
    const metadataItems = CallbackMetadata?.Item || [];
    const receiptNumber =
      String(getItemValue(metadataItems, 'MpesaReceiptNumber') || `MPESA-${Date.now()}`);
    const paidAmount = Number(getItemValue(metadataItems, 'Amount') || txRecord.amount);

    if (!targetPlan) {
      targetPlan = memoryStore.getPlanById(txRecord.target_plan_id) || null;
    }
    if (!subscriber) {
      subscriber = memoryStore.getSubscriber();
    }

    if (!targetPlan || !subscriber) {
      return NextResponse.json(
        { ResultCode: 1, ResultDesc: 'Subscriber or target plan metadata unresolvable' },
        { status: 500 }
      );
    }

    // Amount validation
    if (paidAmount < targetPlan.price_kes) {
      console.error(
        `[M-Pesa Webhook] Underpayment detected: Received KES ${paidAmount}, required KES ${targetPlan.price_kes}`
      );
      return NextResponse.json(
        { ResultCode: 1, ResultDesc: 'Underpayment: Paid amount is less than plan price' },
        { status: 400 }
      );
    }

    // 5. Automated SSH to RHEL FreeRADIUS & RFC 5176 CoA Execution
    console.log(
      `[RADIUS CoA] Initiating FreeRADIUS update for ${subscriber.username} to ${targetPlan.rate_limit} (VLAN ${targetPlan.vlan_id})...`
    );

    const radiusResult = await provisionRadiusSubscriber({
      username: subscriber.username,
      rateLimit: targetPlan.rate_limit,
      vlanId: targetPlan.vlan_id,
    });

    console.log(
      `[RADIUS CoA] Result: ${radiusResult.output} (DryRun: ${radiusResult.dryRun}) in ${radiusResult.durationMs}ms`
    );

    // 6. Supabase ACID RPC Idempotent Commit
    let rpcOutput: unknown = null;
    try {
      const { data: rpcRes, error: rpcErr } = await supabaseAdmin.rpc(
        'complete_mpesa_provisioning',
        {
          p_checkout_request_id: CheckoutRequestID,
          p_mpesa_receipt: receiptNumber,
          p_raw_payload: rawPayload,
        }
      );

      if (rpcErr) {
        console.warn('Supabase RPC call failed (falling back to memory store sync):', rpcErr);
      } else {
        rpcOutput = rpcRes;
      }
    } catch (err) {
      console.warn('Supabase RPC exception:', err);
    }

    // Synchronize memory store
    const memUpdate = memoryStore.completeTransaction(
      CheckoutRequestID,
      receiptNumber,
      rawPayload as Record<string, unknown>
    );

    return NextResponse.json({
      ResultCode: 0,
      ResultDesc: 'Payment confirmed & FreeRADIUS CoA provisioned successfully',
      receiptNumber,
      subscriber: memUpdate.subscriber,
      radiusProvisioning: radiusResult,
      rpcOutput,
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Unknown internal error';
    console.error('[M-Pesa Webhook Exception]', error);
    return NextResponse.json(
      { ResultCode: 1, ResultDesc: `Provisioning pipeline failure: ${errMsg}` },
      { status: 500 }
    );
  }
}
