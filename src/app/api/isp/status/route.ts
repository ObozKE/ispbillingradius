import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { memoryStore } from '@/lib/store';

export async function GET() {
  let subscriber = memoryStore.getSubscriber();
  let plans = memoryStore.getPlans();
  let transactions = memoryStore.getAllTransactions();

  try {
    const { data: dbPlans } = await supabaseAdmin
      .from('bandwidth_plans')
      .select('*')
      .order('price_kes', { ascending: true });

    if (dbPlans && dbPlans.length > 0) {
      plans = dbPlans;
    }

    const { data: dbSub } = await supabaseAdmin
      .from('subscribers')
      .select(`
        *,
        bandwidth_plans (*)
      `)
      .eq('username', 'cust_001')
      .single();

    if (dbSub) {
      subscriber = {
        ...dbSub,
        current_plan: dbSub.bandwidth_plans,
      };
    }

    const { data: dbTx } = await supabaseAdmin
      .from('mpesa_transactions')
      .select(`
        *,
        bandwidth_plans (*)
      `)
      .order('created_at', { ascending: false })
      .limit(10);

    if (dbTx && dbTx.length > 0) {
      transactions = dbTx;
    }
  } catch {
    // In local demo without live Supabase, memoryStore fallback is active
  }

  return NextResponse.json({
    subscriber,
    plans,
    transactions,
    auditLogs: memoryStore.getAuditLogs(),
    config: {
      radiusDryRun: process.env.RADIUS_DRY_RUN === 'true',
      radiusHost: process.env.RHEL_RADIUS_HOST || '192.168.10.25',
      nasIp: process.env.RADIUS_NAS_IP || '10.10.10.1',
      darajaEnv: process.env.DARAJA_ENV || 'sandbox',
    },
  });
}
