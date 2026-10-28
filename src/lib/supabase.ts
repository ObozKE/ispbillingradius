import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type TxStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface BandwidthPlan {
  id: string;
  name: string;
  price_kes: number;
  rate_limit: string;
  vlan_id: number;
  description?: string;
  created_at?: string;
}

export interface Subscriber {
  id: string;
  username: string;
  phone_number: string;
  ip_address: string;
  current_plan_id: string;
  updated_at?: string;
  current_plan?: BandwidthPlan;
}

export interface MpesaTransaction {
  id: string;
  checkout_request_id: string;
  merchant_request_id?: string;
  mpesa_receipt_number?: string | null;
  amount: number;
  phone_number: string;
  status: TxStatus;
  radius_provisioned: boolean;
  subscriber_id: string;
  target_plan_id: string;
  raw_callback_payload?: Record<string, unknown> | null;
  created_at: string;
  completed_at?: string | null;
  subscriber?: Subscriber;
  target_plan?: BandwidthPlan;
}

// Ensure valid URL strings to avoid initialization runtime crashes
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://demo-isp-radius.supabase.co';
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'demo-anon-key-placeholder';
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseAnonKey;

// Browser client for frontend subscriptions (Supabase Realtime)
export const supabaseBrowser: SupabaseClient = createClient(
  supabaseUrl,
  supabaseAnonKey
);

// Admin server client for route handlers (bypasses RLS with service_role)
export const supabaseAdmin: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

// Fallback seed data in case Supabase backend is unreachable in local demo mode
export const SEED_PLANS: BandwidthPlan[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Home Fiber 10 Mbps',
    price_kes: 2500,
    rate_limit: '10M/10M',
    vlan_id: 100,
    description: 'Entry-level residential fiber broadband with symmetric 10M rate-limit',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Business Fiber 50 Mbps',
    price_kes: 4500,
    rate_limit: '50M/50M',
    vlan_id: 200,
    description: 'High-speed business tier with priority VLAN tag 200 and low latency routing',
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'Enterprise Fiber 100 Mbps',
    price_kes: 8500,
    rate_limit: '100M/100M',
    vlan_id: 300,
    description: 'Dedicated enterprise symmetrical fiber with 24/7 SLA and dual-homed routing',
  },
];

export const SEED_SUBSCRIBER: Subscriber = {
  id: '99999999-9999-9999-9999-999999999999',
  username: 'cust_001',
  phone_number: '254712345678',
  ip_address: '10.10.100.50',
  current_plan_id: '11111111-1111-1111-1111-111111111111',
  updated_at: new Date().toISOString(),
  current_plan: SEED_PLANS[0],
};
