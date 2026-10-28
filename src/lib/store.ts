/**
 * In-Memory Fallback State Engine
 * Mirrors the Supabase PostgreSQL database during local demo or dry-run evaluation.
 */

import {
  BandwidthPlan,
  Subscriber,
  MpesaTransaction,
  SEED_PLANS,
  SEED_SUBSCRIBER,
} from './supabase';

class IspMemoryStore {
  private plans: BandwidthPlan[] = [...SEED_PLANS];
  private subscriber: Subscriber = { ...SEED_SUBSCRIBER };
  private transactions: Map<string, MpesaTransaction> = new Map();
  private auditLogs: Array<{
    timestamp: string;
    stage: string;
    message: string;
    metadata?: Record<string, unknown>;
  }> = [];

  constructor() {
    this.addAuditLog('SYSTEM_INIT', 'ISP Provisioning Engine initialized in Dry-Run / Demo mode');
  }

  getPlans(): BandwidthPlan[] {
    return this.plans;
  }

  getPlanById(id: string): BandwidthPlan | undefined {
    return this.plans.find((p) => p.id === id);
  }

  getSubscriber(): Subscriber {
    const plan = this.getPlanById(this.subscriber.current_plan_id) || this.plans[0];
    return {
      ...this.subscriber,
      current_plan: plan,
    };
  }

  createTransaction(tx: Omit<MpesaTransaction, 'id' | 'created_at'>): MpesaTransaction {
    const id = `tx_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const created: MpesaTransaction = {
      ...tx,
      id,
      created_at: new Date().toISOString(),
      target_plan: this.getPlanById(tx.target_plan_id),
      subscriber: this.getSubscriber(),
    };
    this.transactions.set(tx.checkout_request_id, created);
    this.addAuditLog(
      'STK_INITIATED',
      `STK Push created for ${tx.phone_number} - Amount KES ${tx.amount}`,
      { checkoutRequestId: tx.checkout_request_id }
    );
    return created;
  }

  getTransaction(checkoutRequestId: string): MpesaTransaction | undefined {
    return this.transactions.get(checkoutRequestId);
  }

  getAllTransactions(): MpesaTransaction[] {
    return Array.from(this.transactions.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }

  completeTransaction(
    checkoutRequestId: string,
    receiptNumber: string,
    rawPayload: Record<string, unknown>
  ): { success: boolean; message: string; subscriber: Subscriber } {
    const tx = this.transactions.get(checkoutRequestId);
    if (!tx) {
      return { success: false, message: 'Transaction not found', subscriber: this.getSubscriber() };
    }

    if (tx.status === 'COMPLETED' && tx.radius_provisioned) {
      return {
        success: true,
        message: 'Transaction already completed (Idempotent replay)',
        subscriber: this.getSubscriber(),
      };
    }

    const targetPlan = this.getPlanById(tx.target_plan_id);
    if (!targetPlan) {
      return { success: false, message: 'Target plan not found', subscriber: this.getSubscriber() };
    }

    // Update Transaction
    tx.status = 'COMPLETED';
    tx.radius_provisioned = true;
    tx.mpesa_receipt_number = receiptNumber;
    tx.raw_callback_payload = rawPayload;
    tx.completed_at = new Date().toISOString();
    this.transactions.set(checkoutRequestId, tx);

    // Atomically upgrade subscriber
    this.subscriber.current_plan_id = targetPlan.id;
    this.subscriber.updated_at = new Date().toISOString();
    this.subscriber.current_plan = targetPlan;

    this.addAuditLog(
      'PROVISION_COMPLETE',
      `Subscriber ${this.subscriber.username} upgraded to ${targetPlan.name} (${targetPlan.rate_limit}, VLAN ${targetPlan.vlan_id})`,
      { receiptNumber, checkoutRequestId }
    );

    return {
      success: true,
      message: 'Plan upgraded successfully',
      subscriber: this.getSubscriber(),
    };
  }

  failTransaction(checkoutRequestId: string, rawPayload: Record<string, unknown>) {
    const tx = this.transactions.get(checkoutRequestId);
    if (tx) {
      tx.status = 'FAILED';
      tx.raw_callback_payload = rawPayload;
      tx.completed_at = new Date().toISOString();
      this.transactions.set(checkoutRequestId, tx);
      this.addAuditLog('TRANSACTION_FAILED', `Payment failed for ${checkoutRequestId}`);
    }
  }

  addAuditLog(stage: string, message: string, metadata?: Record<string, unknown>) {
    this.auditLogs.unshift({
      timestamp: new Date().toISOString(),
      stage,
      message,
      metadata,
    });
    if (this.auditLogs.length > 50) {
      this.auditLogs.pop();
    }
  }

  getAuditLogs() {
    return this.auditLogs;
  }
}

// Global singleton across hot-reloads in development
declare global {
  // eslint-disable-next-line no-var
  var __ispMemoryStore: IspMemoryStore | undefined;
}

export const memoryStore = globalThis.__ispMemoryStore || new IspMemoryStore();
if (process.env.NODE_ENV !== 'production') {
  globalThis.__ispMemoryStore = memoryStore;
}
