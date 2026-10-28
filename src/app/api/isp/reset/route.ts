import { NextResponse } from 'next/server';
import { supabaseAdmin, SEED_PLANS } from '@/lib/supabase';
import { memoryStore } from '@/lib/store';

export async function POST() {
  try {
    const basePlan = SEED_PLANS[0]; // 10 Mbps

    // Reset database if accessible
    try {
      await supabaseAdmin
        .from('subscribers')
        .update({
          current_plan_id: basePlan.id,
          updated_at: new Date().toISOString(),
        })
        .eq('username', 'cust_001');

      await supabaseAdmin.from('mpesa_transactions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    } catch {
      // Memory store fallback
    }

    // Reset in-memory store
    const sub = memoryStore.getSubscriber();
    sub.current_plan_id = basePlan.id;
    sub.current_plan = basePlan;
    sub.updated_at = new Date().toISOString();
    memoryStore.addAuditLog('DEMO_RESET', 'Subscriber reset to base tier: Home Fiber 10 Mbps (VLAN 100)');

    return NextResponse.json({
      success: true,
      message: 'Subscriber reset to base 10 Mbps plan',
      subscriber: sub,
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Reset failed';
    return NextResponse.json({ success: false, error: errMsg }, { status: 500 });
  }
}
